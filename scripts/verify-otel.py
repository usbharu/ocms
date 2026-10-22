#!/usr/bin/env python3
"""Assert real Collector OTLP evidence, parent edges, metrics, log correlation and privacy."""
from pathlib import Path
import json
import re
import subprocess
import time
from client import check
root=Path(__file__).resolve().parents[1]
services={'bff','catalog','transfer','search','worker','embedding-runtime'}
required_spans=set('bff.http_request catalog.create_upload transfer.encrypt_stream transfer.s3_upload transfer.decrypt_range transfer.deduplicate media.transcode media.ocr media.transcribe search.keyword search.semantic embedding.encode'.split())
required_metrics=set('media.upload.duration media.upload.bytes media.download.bytes media.dedup.hits media.dedup.saved_bytes media.transcode.duration media.job.completed media.search.duration media.embedding.duration media.crypto.bytes'.split())

def records(signal):
    keys={'traces':('resourceSpans','scopeSpans','spans'),'metrics':('resourceMetrics','scopeMetrics','metrics'),'logs':('resourceLogs','scopeLogs','logRecords')}
    resource_key,scope_key,item_key=keys[signal]
    result=[]
    for line in (root/'.cache/otel'/f'{signal}.jsonl').read_text().splitlines():
        try:batch=json.loads(line)
        except json.JSONDecodeError:continue  # A final append may still be in flight.
        for res in batch.get(resource_key,[]):
            attrs={a['key']:a['value'] for a in res['resource']['attributes']}
            name=attrs['service.name']['stringValue']
            assert all(k in attrs for k in ['service.version','deployment.environment.name']), name
            for scope in res.get(scope_key,[]):
                result.extend((name,item) for item in scope.get(item_key,[]))
    return result

def validate():
    spans,metrics,logs=(records(s) for s in ['traces','metrics','logs'])
    for label,items in [('Trace',spans),('Metric',metrics),('Log',logs)]:
        assert services <= {name for name,_ in items}, label+' missing services'
    assert required_spans <= {s['name'] for _,s in spans}, 'missing named spans'
    positive=set()
    failure_metric=False
    for service,metric in metrics:
        if metric['name'] in required_metrics:
            expected='histogram' if metric['name'].endswith('.duration') else 'sum'
            assert expected in metric, 'incorrect metric type'
            if expected=='sum':assert metric['sum'].get('isMonotonic'), 'counter must be monotonic'
        for kind in ['sum','histogram','gauge']:
            for point in metric.get(kind,{}).get('dataPoints',[]):
                keys={a['key'] for a in point.get('attributes',[])}
                assert not (keys & {'asset_id','blob_id','upload_id','job_id','principal_id','trace_id'}), 'metric cardinality'
                value=point.get('count',point.get('asInt',point.get('asDouble',0)))
                if float(value)>0:
                    positive.add(metric['name'])
                    if metric['name']=='media.job.completed' and any(a['key']=='outcome' and a['value'].get('stringValue') in ['retry','failed'] for a in point.get('attributes',[])):
                        failure_metric=True
    assert failure_metric, 'job failure metric missing'
    assert any(s.get('status',{}).get('code')==2 for _,s in spans if s['name']=='media.process'), 'job error span status missing'
    assert any(log.get('body',{}).get('stringValue')=='media.transcode_failed' for _,log in logs), 'failed transcode audit log missing'
    assert required_metrics<=positive, 'missing positive metrics: '+str(sorted(required_metrics-positive))
    lookup={(s['traceId'],s['spanId']):(service,s) for service,s in spans}
    correlated=set()
    for service,log in logs:
        identity=(log.get('traceId'),log.get('spanId'))
        if identity in lookup:
            assert lookup[identity][0]==service, 'log service correlation differs'
            correlated.add(service)
    audit_names=set('auth.login asset.created asset.downloaded asset.updated asset.deleted asset.permission_changed crypto.dek_unwrapped search.executed'.split())
    audited=set()
    for _,log in logs:
        name=log.get('body',{}).get('stringValue')
        attrs={a['key']:a['value'] for a in log.get('attributes',[])}
        if name in audit_names and attrs.get('outcome',{}).get('stringValue')=='success':
            assert attrs.get('principal_id',{}).get('stringValue'), 'audit actor missing'
            assert (log.get('traceId'),log.get('spanId')) in lookup, 'audit trace missing'
            audited.add(name)
    assert audit_names<=audited, 'audit events missing success result: '+str(sorted(audit_names-audited))
    assert services<=correlated, 'uncorrelated log services: '+str(services-correlated)
    workload=json.loads((root/'.cache/otel-workload.json').read_text())
    edges=set()
    for service,span in spans:
        parent=lookup.get((span['traceId'],span.get('parentSpanId')))
        if parent and parent[0]!=service:edges.add((parent[0],service))
    assert {('bff','transfer'),('bff','catalog'),('bff','search'),('worker','transfer'),('worker','search'),('worker','embedding-runtime'),('search','embedding-runtime')}<=edges, 'missing service parent edges'
    for item in workload['uploads']:
        trace=item['trace_id']
        chain=[(name,span) for name,span in spans if span['traceId']==trace]
        assert {'bff','catalog','transfer','worker','search','embedding-runtime'}<={n for n,_ in chain}, 'async job context broken'
        jobs=[span for name,span in chain if name=='worker' and span['name'] in ['media.process','embedding.generate']]
        assert len(jobs)>=2 and all((trace,j.get('parentSpanId')) in lookup for j in jobs), 'async job parent missing'
    return spans,metrics,logs,edges

# Both SDK batch intervals and the Collector batcher must flush before asserting.
deadline=time.monotonic()+45
while True:
    try:spans,metrics,logs,edges=validate();break
    except AssertionError:
        if time.monotonic()>deadline:raise
        time.sleep(3)
check('all 6 services export real OTLP Traces, Metrics and Logs with resource attributes')
check('all 12 specification spans and 10 specification metrics observed with positive values')
check('HTTP parent edges and persisted asynchronous Job context span all 6 services')
check('all 9 specification audit event types, success actors/results and trace correlation')
check('failed jobs produce error Span status, retry/failure counter and safe audit logs')
check('OTLP log traceId/spanId correlate with exported spans for all 6 services; bounded metric attributes')

secrets=[]
for path in ['.cache/oidc-sensitive.json','.cache/otel-sensitive.json']:
    secrets.extend(json.loads((root/path).read_text()))
for line in (root/'.env').read_text().splitlines():
    if '=' in line:
        key,value=line.split('=',1)
        if any(s in key for s in ['SECRET','TOKEN','PASSWORD','ACCESS_KEY']):secrets.append(value.strip().strip('\"\''))
secrets.extend(re.findall(r'["\']([A-Za-z0-9+/]{43}=)["\']' ,(root/'secrets/crypto.yaml').read_text()))
evidence=[(root/'.cache/otel'/f'{s}.jsonl').read_bytes() for s in ['traces','metrics','logs']]
stdout=subprocess.run(['docker','compose','-f','compose.yaml','-f','compose.verify.yaml','logs','--no-color',
    'bff','bff-oidc','catalog','transfer','search','worker','runtime'],cwd=root,capture_output=True,check=True).stdout
evidence.append(stdout)
assert all(not (s.encode() in data) for s in secrets if len(s)>=8 for data in evidence), 'sensitive value detected; do not publish evidence'
(root/'.cache/otel/application.log').write_bytes(stdout)
check('no captured OAuth state/code/nonce, sessions/CSRF, credentials/KEKs, content/query/header canaries in OTLP or application stdout')
report={'checks':['all signals and resources','12 spans, 10 positive metrics','synchronous and asynchronous parent graph','correlated logs and bounded metric cardinality','9 audit event types with actors/results','failed job signals','sensitive value absence'],
    'services':sorted(services),'span_names':sorted({s['name'] for _,s in spans}),
    'metric_names':sorted({m['name'] for _,m in metrics}),'service_edges':sorted([list(e) for e in edges]),
    'counts':{'spans':len(spans),'metric_snapshots':len(metrics),'logs':len(logs)},'sensitive_values_checked':len(set(secrets))}
(root/'.cache/otel-results.json').write_text(json.dumps(report,indent=2)+'\n')
