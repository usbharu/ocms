FROM python:3.12-slim-bookworm
ARG RUNTIME_VARIANT=cpu
RUN apt-get update && apt-get install -y --no-install-recommends libsndfile1 libgomp1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY runtime/requirements.txt .
RUN set -eu; \
    case "$RUNTIME_VARIANT" in \
      cpu) ort_package=onnxruntime==1.23.2 ;; \
      cuda) ort_package='onnxruntime-gpu[cuda,cudnn]==1.23.2' ;; \
      *) echo 'RUNTIME_VARIANT must be cpu or cuda' >&2; exit 1 ;; \
    esac; \
    pip install --no-cache-dir -r requirements.txt "$ort_package"; \
    pip check
LABEL dev.ocms.runtime.variant=$RUNTIME_VARIANT
RUN useradd -u 10001 -m app && mkdir /models && chown app /models
COPY runtime/server.py runtime/telemetry.py runtime/tagger.py runtime/ort_support.py runtime/embedding_onnx.py runtime/whisper_onnx.py runtime/recommendation_engine.py runtime/recommendation_server.py ./
COPY scripts/check-runtime-image.py ./
USER app
ENV HF_HOME=/models HF_HUB_DISABLE_PROGRESS_BARS=1 HF_HUB_DISABLE_XET=1 HF_HUB_DISABLE_IMPLICIT_TOKEN=1 TRANSFORMERS_VERBOSITY=error TOKENIZERS_PARALLELISM=false OMP_NUM_THREADS=4 MALLOC_ARENA_MAX=2
RUN python check-runtime-image.py "$RUNTIME_VARIANT"
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]
