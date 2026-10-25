"""Isolated recommendation entrypoint, sharing the image but no inference models."""
import os
import secrets
import threading

from fastapi import FastAPI, Header, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from recommendation_engine import ENGINE_VERSION, recommend
from telemetry import instrument

app = FastAPI(telemetry={'tracing': False, 'metrics': False, 'logs': False,
    'operation_spans': False, 'auto_configure': False})
instrument(app, service_name='recommendation-engine')
slot = threading.Lock()


class AssetInput(BaseModel):
    asset_id: str
    blob_id: str | None = None
    tags: list[str] = Field(default_factory=list, max_length=512)
    characters: list[str] = Field(default_factory=list, max_length=512)
    is_favorite: bool = False
    mime_type: str = ''
    rating: str = ''


class RecommendationInput(BaseModel):
    assets: list[AssetInput]


@app.exception_handler(RequestValidationError)
async def invalid_request(request, exc):
    # FastAPI's default validation response includes the private input values.
    return JSONResponse(status_code=400, content={'error': 'INVALID_REQUEST'})


@app.get('/healthz')
def health():
    return {'status': 'ok', 'engine_version': ENGINE_VERSION}


@app.post('/recommend')
def recommendations(item: RecommendationInput, x_service_token: str | None = Header(default=None)):
    expected = os.environ.get('INTERNAL_TOKEN', '')
    if len(expected) < 32 or not secrets.compare_digest(x_service_token or '', expected):
        raise HTTPException(401, 'AUTH_REQUIRED')
    if not slot.acquire(blocking=False):
        raise HTTPException(503, 'RECOMMENDATION_BUSY')
    try:
        return {'engine_version': ENGINE_VERSION,
                **recommend([a.model_dump() for a in item.assets])}
    except Exception:
        raise HTTPException(503, 'RECOMMENDATION_FAILED') from None
    finally:
        slot.release()
