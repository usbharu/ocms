FROM python:3.12-slim-bookworm
ARG RUNTIME_VARIANT=cpu
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libsndfile1 libgomp1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY runtime/requirements.txt .
RUN set -eu; \
    case "$RUNTIME_VARIANT" in \
      cpu) torch_build=cpu ;; \
      cuda) torch_build=cu130 ;; \
      *) echo 'RUNTIME_VARIANT must be cpu or cuda' >&2; exit 1 ;; \
    esac; \
    pip install --no-cache-dir --index-url "https://download.pytorch.org/whl/${torch_build}" \
      "torch==2.14.1+${torch_build}" "torchvision==0.29.1+${torch_build}" "torchcodec==0.17.0+${torch_build}"; \
    pip freeze | grep -E '^(torch|torchvision|torchcodec)==' > /tmp/torch-constraints.txt; \
    pip install --no-cache-dir -c /tmp/torch-constraints.txt -r requirements.txt \
      av==18.1.0 opentelemetry-sdk==1.44.0 opentelemetry-exporter-otlp-proto-http==1.44.0 onnxruntime==1.23.2; \
    pip check; \
    rm /tmp/torch-constraints.txt
LABEL dev.ocms.runtime.variant=$RUNTIME_VARIANT
RUN useradd -u 10001 -m app && mkdir /models && chown app /models
COPY runtime/server.py runtime/telemetry.py runtime/tagger.py ./
COPY scripts/check-runtime-image.py ./
USER app
ENV HF_HOME=/models HF_HUB_DISABLE_PROGRESS_BARS=1 TOKENIZERS_PARALLELISM=false OMP_NUM_THREADS=4 MALLOC_ARENA_MAX=2
RUN python check-runtime-image.py "$RUNTIME_VARIANT"
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]
