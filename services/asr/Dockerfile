# The upstream image provides Qwen3-ASR, vLLM, and the CUDA runtime.
FROM qwenllm/qwen3-asr:latest

WORKDIR /app
COPY pyproject.toml README.md ./
COPY src ./src
RUN pip3 install --no-cache-dir '.[server]'

ENV PYTHONPATH=/app/src
EXPOSE 8000
CMD ["python3", "-m", "meeting_asr"]
