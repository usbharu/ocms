"""OTLP instrumentation with an explicit safe attribute allowlist."""
from contextlib import asynccontextmanager
import json
import logging
import os
import time
from opentelemetry import metrics, trace
from opentelemetry.propagate import extract
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter


def instrument(app):
    resource = Resource.create({'service.name': 'embedding-runtime', 'service.version': '0.2.0',
        'deployment.environment.name': os.environ.get('DEPLOYMENT_ENVIRONMENT', 'development')})
    tp, lp = TracerProvider(resource=resource), LoggerProvider(resource=resource)
    readers = []
    enabled = bool(os.environ.get('OTEL_EXPORTER_OTLP_ENDPOINT'))
    if enabled:
        tp.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(), schedule_delay_millis=1000))
        lp.add_log_record_processor(BatchLogRecordProcessor(OTLPLogExporter(), schedule_delay_millis=1000))
        readers.append(PeriodicExportingMetricReader(OTLPMetricExporter(), export_interval_millis=3000))
    mp = MeterProvider(resource=resource, metric_readers=readers)
    trace.set_tracer_provider(tp); metrics.set_meter_provider(mp)
    tracer = trace.get_tracer('ocms.runtime')
    meter = metrics.get_meter('ocms.runtime')
    duration = meter.create_histogram('media.embedding.duration', unit='s')
    requests = meter.create_counter('runtime.requests')
    logger = logging.getLogger('ocms.runtime')
    logger.setLevel(logging.INFO); logger.propagate = False
    if enabled:
        logger.addHandler(LoggingHandler(logger_provider=lp))
    class SafeJSON(logging.Handler):
        def emit(self, record):
            sc = trace.get_current_span().get_span_context()
            print(json.dumps({'service.name': 'embedding-runtime', 'event': record.getMessage(),
                'trace_id': format(sc.trace_id, '032x'), 'span_id': format(sc.span_id, '016x')}), flush=True)
    logger.addHandler(SafeJSON())
    @app.middleware('http')
    async def telemetry(request, call_next):
        if request.url.path == '/healthz':
            return await call_next(request)
        operation = {'/encode': 'embedding.encode', '/transcribe': 'media.transcribe', '/tag': 'media.tag'}.get(request.url.path, 'inference.request')
        with tracer.start_as_current_span(operation, context=extract(dict(request.headers)), kind=trace.SpanKind.SERVER, record_exception=False, set_status_on_exception=False) as span:
            started = time.monotonic()
            try:
                response = await call_next(request)
            except Exception:
                span.set_status(trace.Status(trace.StatusCode.ERROR, 'Inference failed'))
                requests.add(1, {'operation': operation, 'outcome': 'error'})
                logger.error(operation + '.failed')
                raise
            span.set_attribute('http.response.status_code', response.status_code)
            if response.status_code >= 500:
                span.set_status(trace.Status(trace.StatusCode.ERROR, 'Inference failed'))
            attributes = {'operation': operation, 'outcome': 'success' if response.status_code < 400 else 'error'}
            requests.add(1, attributes)
            if operation == 'embedding.encode': duration.record(time.monotonic() - started, attributes)
            logger.info(operation + ('.completed' if response.status_code < 400 else '.failed'))
            return response
    def shutdown():
        lp.shutdown(); mp.shutdown(); tp.shutdown()
    previous_lifespan = app.router.lifespan_context
    @asynccontextmanager
    async def lifespan(instance):
        async with previous_lifespan(instance):
            try:
                yield
            finally:
                shutdown()
    app.router.lifespan_context = lifespan
