"""Isolated recommendation entrypoint, sharing the image but no inference models."""
import os
import secrets
import threading

from fastapi import FastAPI, Header, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, model_validator
from recommendation_engine import ENGINE_VERSION, recommend
from telemetry import instrument

app = FastAPI(telemetry={'tracing': False, 'metrics': False, 'logs': False,
    'operation_spans': False, 'auto_configure': False})
instrument(app, service_name='recommendation-engine')
slot = threading.Lock()


class AssetInput(BaseModel):
    asset_id: str
    blob_id: str | None = None
    blob_ids: list[str] = Field(default_factory=list)
    series_kind: str = ''
    tags: list[str] = Field(default_factory=list)
    characters: list[str] = Field(default_factory=list)
    is_favorite: bool = False
    mime_type: str = ''
    rating: str = ''

    @model_validator(mode='after')
    def validate_metadata_size(self):
        if self.series_kind not in ('', 'collection', 'composite'):
            raise ValueError('invalid series kind')
        # Series contain the complete union of their constituent metadata.
        if not self.series_kind and (len(self.tags) > 512 or len(self.characters) > 512):
            raise ValueError('too many labels')
        return self


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
