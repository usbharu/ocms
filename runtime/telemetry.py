"""OTLP instrumentation with an explicit safe attribute allowlist."""
from contextlib import asynccontextmanager
import json
import logging
import os
import time
from opentelemetry import trace
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


def instrument(app, service_name='embedding-runtime'):
    resource = Resource.create({'service.name': service_name, 'service.version': '0.2.0',
        'deployment.environment.name': os.environ.get('DEPLOYMENT_ENVIRONMENT', 'development')})
    tp, lp = TracerProvider(resource=resource), LoggerProvider(resource=resource)
    readers = []
    enabled = bool(os.environ.get('OTEL_EXPORTER_OTLP_ENDPOINT'))
    if enabled:
        tp.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(), schedule_delay_millis=1000))
        lp.add_log_record_processor(BatchLogRecordProcessor(OTLPLogExporter(), schedule_delay_millis=1000))
        readers.append(PeriodicExportingMetricReader(OTLPMetricExporter(), export_interval_millis=3000))
    mp = MeterProvider(resource=resource, metric_readers=readers)
    # Each app owns its providers, including when both entrypoints are imported.
    tracer = tp.get_tracer('ocms.runtime')
    meter = mp.get_meter('ocms.runtime')
    duration = meter.create_histogram('media.embedding.duration', unit='s')
    request_duration = meter.create_histogram('http.server.request.duration', unit='s')
    requests = meter.create_counter('runtime.requests')
    logger = logging.getLogger('ocms.' + service_name)
    logger.setLevel(logging.INFO); logger.propagate = False
    handlers = []
    if enabled:
        handlers.append(LoggingHandler(logger_provider=lp))
    class SafeJSON(logging.Handler):
        def emit(self, record):
            sc = trace.get_current_span().get_span_context()
            print(json.dumps({'service.name': service_name, 'event': record.getMessage(),
                'level': record.levelname,
                'trace_id': format(sc.trace_id, '032x'), 'span_id': format(sc.span_id, '016x')}), flush=True)
    handlers.append(SafeJSON())
    for handler in handlers:
        logger.addHandler(handler)
    @app.middleware('http')
    async def telemetry(request, call_next):
        if request.url.path == '/healthz':
            return await call_next(request)
        operation = {'/encode': 'embedding.encode', '/transcribe': 'media.transcribe', '/tag': 'media.tag', '/recommend': 'recommendation.rank'}.get(request.url.path, 'inference.request')
        with tracer.start_as_current_span(operation, context=extract(dict(request.headers)), kind=trace.SpanKind.SERVER, record_exception=False, set_status_on_exception=False) as span:
            started = time.monotonic()
            status = 500
            try:
                response = await call_next(request)
                status = response.status_code
                return response
            finally:
                span.set_attribute('http.response.status_code', status)
                if status >= 500:
                    span.set_status(trace.Status(trace.StatusCode.ERROR, 'Inference failed'))
                attributes = {'operation': operation, 'outcome': 'success' if status < 400 else 'error'}
                elapsed = time.monotonic() - started
                requests.add(1, attributes)
                request_duration.record(elapsed, attributes)
                if operation == 'embedding.encode':
                    duration.record(elapsed, attributes)
                level = logging.ERROR if status >= 500 else logging.WARNING if status >= 400 else logging.INFO
                logger.log(level, operation + ('.completed' if status < 400 else '.failed'))
    def shutdown():
        lp.shutdown(); mp.shutdown(); tp.shutdown()
        for handler in handlers:
            logger.removeHandler(handler)
            handler.close()
    previous_lifespan = app.router.lifespan_context
    @asynccontextmanager
    async def lifespan(instance):
        async with previous_lifespan(instance):
            try:
                yield
            finally:
                shutdown()
    app.router.lifespan_context = lifespan
