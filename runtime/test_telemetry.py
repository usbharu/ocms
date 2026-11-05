"""Exercise real SDK batching and OTLP encoding without models or a collector."""
from contextlib import redirect_stdout
import io
import json
import logging
import os
import unittest
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import ExportLogsServiceRequest
from opentelemetry.proto.collector.metrics.v1.metrics_service_pb2 import ExportMetricsServiceRequest
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
from requests import Response

from telemetry import instrument


CANARY = 'private-input-must-not-be-exported'
TRACE_ID = '1234567890abcdef1234567890abcdef'
PARENT_ID = '1234567890abcdef'


def application(service='embedding-runtime'):
    app = FastAPI(telemetry={'tracing': False, 'metrics': False, 'logs': False,
        'operation_spans': False, 'auto_configure': False})

    @app.post('/encode')
    @app.post('/transcribe')
    @app.post('/tag')
    @app.post('/recommend')
    def infer():
        return {'text': CANARY}

    @app.post('/denied')
    def denied():
        raise HTTPException(401, CANARY)

    @app.post('/unavailable')
    def unavailable():
        raise HTTPException(503, CANARY)

    @app.post('/broken')
    def broken():
        raise ValueError(CANARY)

    @app.get('/healthz')
    def health():
        return {'status': 'ok'}

    instrument(app, service)
    return app


class TelemetryTests(unittest.TestCase):
    def setUp(self):
        # Other unit tests import the production apps without running lifespan.
        for service in ('embedding-runtime', 'recommendation-engine'):
            self.enterContext(patch.object(logging.getLogger('ocms.' + service), 'handlers', []))
        self.output = io.StringIO()
        self.enterContext(redirect_stdout(self.output))
        # No host OTEL settings may redirect exports or change sampling.
        self.enterContext(patch.dict(os.environ, {
            'OTEL_EXPORTER_OTLP_ENDPOINT': 'http://collector:4318',
            'DEPLOYMENT_ENVIRONMENT': 'test',
        }, clear=True))
        self.sent = []

        def send(**kwargs):
            self.sent.append((kwargs['url'], kwargs['data']))
            response = Response()
            response.status_code = 200
            response._content = b''
            return response

        # Only the network boundary is replaced; SDKs and serializers are real.
        self.enterContext(patch('requests.Session.request', side_effect=send))

    def signals(self):
        spans, metrics, logs = [], [], []
        for endpoint, payload in self.sent:
            self.assertNotIn(CANARY.encode(), payload)
            if endpoint.endswith('/v1/traces'):
                message = ExportTraceServiceRequest.FromString(payload)
                spans.extend((r.resource, s) for r in message.resource_spans
                             for scope in r.scope_spans for s in scope.spans)
            elif endpoint.endswith('/v1/metrics'):
                message = ExportMetricsServiceRequest.FromString(payload)
                metrics.extend(m for r in message.resource_metrics
                               for scope in r.scope_metrics for m in scope.metrics)
            elif endpoint.endswith('/v1/logs'):
                message = ExportLogsServiceRequest.FromString(payload)
                logs.extend(l for r in message.resource_logs
                            for scope in r.scope_logs for l in scope.log_records)
            else:
                self.fail('unexpected OTLP endpoint')
        self.assertNotIn(CANARY, self.output.getvalue())
        return spans, metrics, logs

    def test_all_operations_export_correlated_traces_metrics_and_logs_on_shutdown(self):
        with TestClient(application()) as client:
            for path in ('encode', 'transcribe', 'tag', 'recommend'):
                self.assertEqual(client.post('/' + path + '?query=' + CANARY,
                    headers={'traceparent': f'00-{TRACE_ID}-{PARENT_ID}-01',
                             'authorization': CANARY, 'cookie': CANARY},
                    content=CANARY).status_code, 200)
            client.get('/healthz')
        spans, metrics, logs = self.signals()
        operations = {'embedding.encode', 'media.transcribe', 'media.tag', 'recommendation.rank'}
        self.assertEqual({s.name for _, s in spans}, operations)
        self.assertEqual(len(spans), 4)
        for resource, span in spans:
            self.assertEqual(span.trace_id.hex(), TRACE_ID)
            self.assertEqual(span.parent_span_id.hex(), PARENT_ID)
            attrs = {a.key: a.value for a in resource.attributes}
            self.assertEqual(attrs['service.name'].string_value, 'embedding-runtime')
            self.assertEqual(attrs['deployment.environment.name'].string_value, 'test')
            self.assertEqual({a.key for a in span.attributes}, {'http.response.status_code'})
            self.assertEqual(list(span.events), [])
        self.assertEqual({m.name for m in metrics}, {
            'runtime.requests', 'http.server.request.duration', 'media.embedding.duration'})
        duration = next(m for m in metrics if m.name == 'http.server.request.duration')
        self.assertEqual(sum(p.count for p in duration.histogram.data_points), 4)
        self.assertEqual(len(logs), 4)
        self.assertEqual({l.span_id for l in logs}, {s.span_id for _, s in spans})
        self.assertTrue(all(l.trace_id.hex() == TRACE_ID for l in logs))
        self.assertEqual(len(self.output.getvalue().splitlines()), 4)
        self.assertEqual(logging.getLogger('ocms.embedding-runtime').handlers, [])

    def test_http_and_unhandled_errors_are_counted_without_exception_details(self):
        with TestClient(application(), raise_server_exceptions=False) as client:
            for path, status in (('denied', 401), ('unavailable', 503), ('broken', 500),
                                 (CANARY, 404)):
                self.assertEqual(client.post('/' + path).status_code, status)
        spans, metrics, logs = self.signals()
        self.assertEqual(len(spans), 4)
        self.assertEqual(sum(s.status.code == 2 for _, s in spans), 2)
        self.assertTrue(all(not s.events for _, s in spans))
        requests = next(m for m in metrics if m.name == 'runtime.requests')
        self.assertEqual(sum(p.as_int for p in requests.sum.data_points), 4)
        duration = next(m for m in metrics if m.name == 'http.server.request.duration')
        self.assertEqual(sum(p.count for p in duration.histogram.data_points), 4)
        self.assertEqual(len(logs), 4)
        self.assertTrue(all(l.body.string_value.endswith('.failed') for l in logs))

    def test_apps_keep_separate_resources(self):
        # Importing another app must not bind instrumentation to the first SDK.
        first = application()
        second = application('recommendation-engine')
        with TestClient(first) as client:
            client.post('/encode')
        with TestClient(second) as client:
            client.post('/recommend')
        spans, _, _ = self.signals()
        resources = {s.name: next(a.value.string_value for a in r.attributes
                                 if a.key == 'service.name') for r, s in spans}
        self.assertEqual(resources, {'embedding.encode': 'embedding-runtime',
                                    'recommendation.rank': 'recommendation-engine'})

    def test_without_endpoint_only_safe_json_is_written(self):
        with patch.dict(os.environ, {'OTEL_EXPORTER_OTLP_ENDPOINT': ''}), \
                patch('telemetry.OTLPSpanExporter') as traces, \
                patch('telemetry.OTLPMetricExporter') as metrics, \
                patch('telemetry.OTLPLogExporter') as logs:
            with TestClient(application()) as client:
                client.post('/encode', content=CANARY)
            traces.assert_not_called()
            metrics.assert_not_called()
            logs.assert_not_called()
        self.assertEqual(self.sent, [])
        record = json.loads(self.output.getvalue())
        self.assertEqual(record['event'], 'embedding.encode.completed')
        self.assertEqual(record['level'], 'INFO')
        self.assertNotEqual(record['trace_id'], '0' * 32)
        self.assertNotIn(CANARY, self.output.getvalue())
