import os

import uvicorn

from meeting_asr.app import create_app


def main() -> None:
    from qwen_asr import Qwen3ASRModel

    model_name = os.environ.get("ASR_MODEL", "Qwen/Qwen3-ASR-0.6B")
    api_token = os.environ.get("ASR_API_TOKEN", "").strip()
    if not api_token:
        raise RuntimeError("ASR_API_TOKEN must be set")

    gpu_memory_utilization = float(os.environ.get("ASR_GPU_MEMORY_UTILIZATION", "0.5"))
    if not 0 < gpu_memory_utilization <= 1:
        raise ValueError("ASR_GPU_MEMORY_UTILIZATION must be between 0 and 1")

    model = Qwen3ASRModel.LLM(
        model=model_name,
        gpu_memory_utilization=gpu_memory_utilization,
        max_new_tokens=32,
    )
    app = create_app(model, model_name, api_token)
    uvicorn.run(
        app,
        host=os.environ.get("ASR_HOST", "0.0.0.0"),
        port=int(os.environ.get("ASR_PORT", "8000")),
        workers=1,
    )


if __name__ == "__main__":
    main()
