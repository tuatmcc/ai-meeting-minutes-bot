import asyncio
import hmac
import json
import logging
import tempfile
from typing import Annotated, Any

import numpy as np
from fastapi import (
    FastAPI,
    File,
    Form,
    Header,
    HTTPException,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)

SAMPLE_RATE = 16_000
MAX_AUDIO_CHUNK_BYTES = 1024 * 1024
MAX_UPLOAD_BYTES = 256 * 1024 * 1024
logger = logging.getLogger(__name__)


def create_app(model: Any, model_name: str, api_token: str) -> FastAPI:
    app = FastAPI(title="Meeting ASR", docs_url=None, redoc_url=None)
    app.state.model = model
    app.state.model_name = model_name
    app.state.api_token = api_token
    app.state.inference_lock = asyncio.Lock()

    @app.get("/health")
    async def health() -> dict[str, bool]:
        return {"ready": True}

    @app.post("/transcribe")
    async def transcribe(
        file: Annotated[UploadFile, File()],
        language: Annotated[str | None, Form()] = None,
        authorization: Annotated[str | None, Header()] = None,
    ) -> dict[str, str | None]:
        _require_token(authorization, app.state.api_token)
        with tempfile.NamedTemporaryFile(suffix=".wav") as audio_file:
            size = 0
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413, detail="Audio file is too large"
                    )
                audio_file.write(chunk)
            if size == 0:
                raise HTTPException(status_code=400, detail="Audio file is empty")
            audio_file.flush()

            async with app.state.inference_lock:
                from vllm import SamplingParams

                streaming_params = app.state.model.sampling_params
                app.state.model.sampling_params = SamplingParams(
                    temperature=0.0, max_tokens=1024
                )
                try:
                    result = await asyncio.to_thread(
                        app.state.model.transcribe,
                        audio=audio_file.name,
                        language=language or None,
                    )
                finally:
                    app.state.model.sampling_params = streaming_params

        transcription = result[0]
        return {
            "model": app.state.model_name,
            "language": transcription.language or None,
            "text": transcription.text,
        }

    @app.websocket("/stream")
    async def stream(websocket: WebSocket) -> None:
        await websocket.accept()
        try:
            start = await websocket.receive_json()
            if not isinstance(start, dict) or start.get("type") != "start":
                await _send_error(websocket, "Expected a start message", 1008)
                return
            if not _token_matches(start.get("token"), app.state.api_token):
                await _send_error(websocket, "Unauthorized", 1008)
                return
            if start.get("sample_rate") != SAMPLE_RATE:
                await _send_error(websocket, "Audio sample rate must be 16000 Hz", 1003)
                return
            language = start.get("language")
            if language is not None and not isinstance(language, str):
                await _send_error(websocket, "Language must be a string or null", 1008)
                return

            state = app.state.model.init_streaming_state(
                language=language or None,
                chunk_size_sec=2.0,
            )
            await websocket.send_json({"type": "ready", "sample_rate": SAMPLE_RATE})

            while True:
                message = await websocket.receive()
                audio = message.get("bytes")
                if audio is not None:
                    if (
                        len(audio) == 0
                        or len(audio) > MAX_AUDIO_CHUNK_BYTES
                        or len(audio) % 4 != 0
                    ):
                        await _send_error(
                            websocket, "Invalid float32 audio chunk", 1003
                        )
                        return
                    samples = np.frombuffer(audio, dtype="<f4")
                    if not np.isfinite(samples).all():
                        await _send_error(
                            websocket, "Audio chunk contains invalid samples", 1003
                        )
                        return

                    async with app.state.inference_lock:
                        state = await asyncio.to_thread(
                            app.state.model.streaming_transcribe, samples, state
                        )
                    await websocket.send_json(
                        _result_message("partial", app.state.model_name, state)
                    )
                    continue

                text = message.get("text")
                if text is None:
                    await _send_error(
                        websocket, "Expected a binary audio chunk or stop message", 1003
                    )
                    return
                try:
                    command = json.loads(text)
                except json.JSONDecodeError:
                    await _send_error(websocket, "Invalid JSON message", 1003)
                    return
                if not isinstance(command, dict) or command.get("type") != "stop":
                    await _send_error(websocket, "Expected a stop message", 1008)
                    return

                async with app.state.inference_lock:
                    state = await asyncio.to_thread(
                        app.state.model.finish_streaming_transcribe, state
                    )
                await websocket.send_json(
                    _result_message("final", app.state.model_name, state)
                )
                await websocket.close(code=1000)
                return
        except WebSocketDisconnect:
            return
        except Exception:
            logger.exception("ASR streaming request failed")
            try:
                await _send_error(websocket, "ASR inference failed", 1011)
            except (RuntimeError, WebSocketDisconnect):
                pass

    return app


def _require_token(authorization: str | None, expected_token: str) -> None:
    scheme, separator, token = (authorization or "").partition(" ")
    if (
        not separator
        or scheme.lower() != "bearer"
        or not _token_matches(token, expected_token)
    ):
        raise HTTPException(
            status_code=401,
            detail="Unauthorized",
            headers={"WWW-Authenticate": "Bearer"},
        )


def _token_matches(token: Any, expected_token: str) -> bool:
    return isinstance(token, str) and hmac.compare_digest(
        token.encode(), expected_token.encode()
    )


async def _send_error(websocket: WebSocket, detail: str, code: int) -> None:
    await websocket.send_json({"type": "error", "detail": detail})
    await websocket.close(code=code)


def _result_message(
    message_type: str, model_name: str, state: Any
) -> dict[str, str | None]:
    return {
        "type": message_type,
        "model": model_name,
        "language": state.language or None,
        "text": state.text,
    }
