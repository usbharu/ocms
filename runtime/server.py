"""Local inference: native multimodal EmbeddingGemma 2 and timestamped Whisper ASR.
No filenames, content, tokens or exceptions containing content enter logs.
"""
import base64
import gc
import ctypes
import io
import logging
import os
import secrets
import threading
from contextlib import ExitStack

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from embedding_onnx import EmbeddingModel, MODEL_ID, REVISION, ARTIFACT_REVISION
from whisper_onnx import WhisperModel

# Keep telemetry under our allowlist: native validation/exception logs can contain input.
app = FastAPI(telemetry={'tracing': False, 'metrics': False, 'logs': False,
    'operation_spans': False, 'auto_configure': False})
from telemetry import instrument
instrument(app)
lock = threading.Lock()
model = None
whisper = None
INFERENCE_DTYPE = os.environ.get('INFERENCE_DTYPE', 'float32')
if INFERENCE_DTYPE != 'float32':
    raise ValueError('ONNX Runtime requires INFERENCE_DTYPE=float32')
INFERENCE_THREADS = int(os.environ.get('INFERENCE_THREADS', '4'))
if not 1 <= INFERENCE_THREADS <= 32:
    raise ValueError('Invalid INFERENCE_THREADS')
if os.environ.get('ASR_MODEL', 'tiny') != 'tiny':
    raise ValueError('ONNX ASR currently requires ASR_MODEL=tiny')


# glibc otherwise retains large CPU inference allocations across differently sized pages.
# The runtime image is Debian/glibc; trimming happens while holding the inference lock.
def release_memory():
    gc.collect()
    ctypes.CDLL(None).malloc_trim(0)


def authorize(token):
    expected = os.environ.get('INTERNAL_TOKEN', '')
    if len(expected) < 32 or not secrets.compare_digest(token or '', expected):
        raise HTTPException(401, 'AUTH_REQUIRED')


class Input(BaseModel):
    kind: str
    text: str = Field(default='', max_length=24000)
    data: str = Field(default='', max_length=48_000_000)
    frames: list[str] = Field(default_factory=list, max_length=8)
    query: bool = False


def decode_image(encoded):
    from PIL import Image
    with Image.open(io.BytesIO(base64.b64decode(encoded, validate=True))) as image:
        return image.convert('RGB')


@app.get('/healthz')
def health():
    return {'status': 'ok', 'model_id': MODEL_ID, 'revision': REVISION, 'loaded': model is not None,
            'inference_dtype': INFERENCE_DTYPE, 'inference_threads': INFERENCE_THREADS,
            'inference_backend': 'onnxruntime', 'artifact_revision': ARTIFACT_REVISION}


@app.post('/encode')
def encode(item: Input, x_service_token: str | None = Header(default=None)):
    authorize(x_service_token)
    global model
    try:
        with lock, ExitStack() as resources:
            import soundfile
            images = []
            if item.kind == 'text':
                value = ('task: search result | query: ' if item.query else 'title: none | text: ') + item.text
            elif item.kind == 'image':
                images = [resources.enter_context(decode_image(item.data))]
                value = images
            elif item.kind == 'video':
                images = [resources.enter_context(decode_image(frame)) for frame in item.frames]
                value = images
            elif item.kind == 'audio':
                samples, rate = soundfile.read(io.BytesIO(base64.b64decode(item.data, validate=True)), dtype='float32')
                if rate != 16000:
                    raise ValueError('audio must be 16 kHz')
                value = samples
            else:
                raise HTTPException(400, 'INVALID_MODALITY')
            try:
                if model is None:
                    model = EmbeddingModel(INFERENCE_THREADS)
                vector = model.encode(item.kind, value)
            finally:
                release_memory()
            if len(vector) != 768 or not all(__import__('math').isfinite(v) for v in vector):
                raise ValueError('invalid output')
            return {'embedding': vector, 'model_id': MODEL_ID, 'model_revision': REVISION}
    except HTTPException:
        raise
    except Exception as error:
        logging.warning('embedding_failed exception_type=%s', type(error).__name__)
        raise HTTPException(503, 'EMBEDDING_FAILED') from None


@app.post('/transcribe')
def transcribe(item: Input, x_service_token: str | None = Header(default=None)):
    authorize(x_service_token)
    global whisper
    try:
        with lock:
            if whisper is None:
                whisper = WhisperModel(INFERENCE_THREADS)
            import soundfile
            samples, rate = soundfile.read(io.BytesIO(base64.b64decode(item.data, validate=True)), dtype='float32')
            if rate != 16000:
                raise ValueError('audio must be 16 kHz')
            try:
                return {'passages': whisper.transcribe(samples)}
            finally:
                release_memory()
    except Exception as error:
        logging.warning('transcription_failed exception_type=%s', type(error).__name__)
        raise HTTPException(503, 'TRANSCRIPTION_FAILED') from None


tagger = None


@app.post('/tag')
def tag(item: Input, x_service_token: str | None = Header(default=None)):
    authorize(x_service_token)
    if item.kind != 'image':
        raise HTTPException(400, 'INVALID_MODALITY')
    global tagger
    try:
        from PIL import Image
        from tagger import Tagger, MODEL_ID as TAG_MODEL, REVISION as TAG_REVISION
        with lock:
            if tagger is None:
                tagger = Tagger(INFERENCE_THREADS)
            with Image.open(io.BytesIO(base64.b64decode(item.data, validate=True))) as image:
                if image.width * image.height > 16_777_216:
                    raise ValueError('image dimensions exceeded')
                tags = tagger.predict(image)
            return {**tags, 'model_id': TAG_MODEL, 'model_revision': TAG_REVISION}
    except Exception as error:
        logging.warning('tagging_failed exception_type=%s', type(error).__name__)
        raise HTTPException(503, 'TAGGING_FAILED') from None
