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
import tempfile
import threading
from contextlib import contextmanager
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

# Keep telemetry under our allowlist: native validation/exception logs can contain input.
app = FastAPI(telemetry={'tracing': False, 'metrics': False, 'logs': False,
    'operation_spans': False, 'auto_configure': False})
from telemetry import instrument
instrument(app)
lock = threading.Lock()
model = None
whisper = None
MODEL_ID = 'google/embeddinggemma-2'
REVISION = '914f7f89142e33e77833254d9c9b90c3cef7303b'
INFERENCE_DTYPE = os.environ.get('INFERENCE_DTYPE', 'float32')
if INFERENCE_DTYPE not in ['float32', 'bfloat16']:
    raise ValueError('Invalid INFERENCE_DTYPE')
INFERENCE_THREADS = int(os.environ.get('INFERENCE_THREADS', '4'))
if not 1 <= INFERENCE_THREADS <= 32:
    raise ValueError('Invalid INFERENCE_THREADS')


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


@contextmanager
def media_file(encoded, suffix):
    data = base64.b64decode(encoded, validate=True)
    with tempfile.TemporaryDirectory(prefix='infer-') as directory:
        path = Path(directory) / ('input' + suffix)
        path.write_bytes(data)
        yield str(path)


@app.get('/healthz')
def health():
    return {'status': 'ok', 'model_id': MODEL_ID, 'revision': REVISION, 'loaded': model is not None, 'inference_dtype': INFERENCE_DTYPE, 'inference_threads': INFERENCE_THREADS}


@app.post('/encode')
def encode(item: Input, x_service_token: str | None = Header(default=None)):
    authorize(x_service_token)
    global model
    try:
        with lock:
            import torch
            from sentence_transformers import SentenceTransformer
            from PIL import Image
            import soundfile
            if model is None:
                torch.set_num_threads(INFERENCE_THREADS)
                model = SentenceTransformer(MODEL_ID, revision=REVISION, device='cpu',
                    model_kwargs={'dtype': getattr(torch, INFERENCE_DTYPE)}, trust_remote_code=False)
                model.max_seq_length = 8192
            if item.kind == 'text':
                value = ('task: search result | query: ' if item.query else 'title: none | text: ') + item.text
            elif item.kind == 'image':
                value = {'image': Image.open(io.BytesIO(base64.b64decode(item.data, validate=True))).convert('RGB')}
            elif item.kind == 'video':
                value = {'video': [Image.open(io.BytesIO(base64.b64decode(frame, validate=True))).convert('RGB') for frame in item.frames]}
            elif item.kind == 'audio':
                samples, rate = soundfile.read(io.BytesIO(base64.b64decode(item.data, validate=True)), dtype='float32')
                if rate != 16000:
                    raise ValueError('audio must be 16 kHz')
                value = {'audio': samples}
            else:
                raise HTTPException(400, 'INVALID_MODALITY')
            try:
                vector = model.encode(value, normalize_embeddings=True, show_progress_bar=False).tolist()
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
        with lock, media_file(item.data, '.wav') as path:
            from faster_whisper import WhisperModel
            if whisper is None:
                whisper = WhisperModel(os.environ.get('ASR_MODEL', 'tiny'), device='cpu', compute_type='int8',
                    cpu_threads=INFERENCE_THREADS, num_workers=1, download_root='/models/whisper')
            import soundfile
            samples, rate = soundfile.read(path, dtype='float32')
            if rate != 16000:
                raise ValueError('audio must be 16 kHz')
            segments, _ = whisper.transcribe(samples, beam_size=3, condition_on_previous_text=False, vad_filter=False)
            return {'passages': [{'kind': 'transcript', 'ordinal': i, 'start_ms': round(s.start * 1000),
                'end_ms': round(s.end * 1000), 'content': s.text.strip()} for i, s in enumerate(segments) if s.text.strip()]}
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
            return {'tags': tags, 'model_id': TAG_MODEL, 'model_revision': TAG_REVISION}
    except Exception as error:
        logging.warning('tagging_failed exception_type=%s', type(error).__name__)
        raise HTTPException(503, 'TAGGING_FAILED') from None
