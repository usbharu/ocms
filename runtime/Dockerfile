FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libsndfile1 libgomp1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY runtime/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN pip install --no-cache-dir torchvision==0.29.1 torchcodec==0.17.0 av==18.1.0
RUN pip install --no-cache-dir opentelemetry-sdk==1.38.0 opentelemetry-exporter-otlp-proto-http==1.38.0
RUN useradd -u 10001 -m app && mkdir /models && chown app /models
COPY runtime/server.py runtime/telemetry.py ./
USER app
ENV HF_HOME=/models HF_HUB_DISABLE_PROGRESS_BARS=1 TOKENIZERS_PARALLELISM=false OMP_NUM_THREADS=4 MALLOC_ARENA_MAX=2
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]
