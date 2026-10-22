#!/usr/bin/env python3
"""Real asynchronous OCR/ASR/embedding jobs under known distributed trace contexts."""
from pathlib import Path
import json
import subprocess
import os
import sys
import secrets
import time
import zlib
import struct
from client import Client, check
root=Path(__file__).resolve().parents[1]
fixtures=root/'.cache/fixtures'
assert (fixtures/'speech.mp3').exists(), 'Run scripts/media-integration.py first'
def audit_events():
    a,b=Client('alice'),Client('bob')
    source=json.loads((root/'.cache/otel-workload.json').read_text())['uploads'][0]['upload']
    body=a.call('GET',f"/api/v1/assets/{source['asset_id']}/content")[2]
    u=a.create('otel-audit.png',body);a.put(u,body)
    a.call('PATCH',f"/api/v1/assets/{u['asset_id']}",{'tags':['otel-audit']})
    probe="""import json,os,sys,urllib.request
asset,owner,reader=sys.argv[1:]
request=urllib.request.Request('http://catalog:8080/internal/assets/'+asset+'/grants',json.dumps({'principal_id':reader,'permission':'read'}).encode(),headers={'Content-Type':'application/json','X-Service-Token':os.environ['INTERNAL_TOKEN'],'X-Principal':owner},method='POST')
assert urllib.request.urlopen(request).status==204
"""
    subprocess.run(['docker','compose','exec','-T','runtime','python','-c',probe,u['asset_id'],a.me['principal_id'],b.me['principal_id']],check=True,capture_output=True)
    b.call('GET',f"/api/v1/assets/{u['asset_id']}/content")
    a.call('POST','/api/v1/search',{'query':'otel-audit','mode':'keyword'})
    a.call('DELETE',f"/api/v1/assets/{u['asset_id']}",expected=204)
    check('successful audit events including internal Catalog Grant change and granted download')

if '--audit-only' in sys.argv:
    audit_events()
    raise SystemExit(0)

a=Client('alice')
canary='private-content-'+secrets.token_hex(16)
png=(fixtures/'ocr.png').read_bytes()
data=b'Comment\0'+canary.encode()
chunk=b'tEXt'+data
png=png[:-12]+struct.pack('>I',len(data))+chunk+struct.pack('>I',zlib.crc32(chunk))+png[-12:]
audio=(fixtures/'speech.mp3').read_bytes()+b'TAG'+canary.encode()[:30].ljust(30,b' ')+bytes(95)
# Validation errors must not produce FastAPI logs containing the submitted body.
probe = """import json,os,urllib.request,urllib.error
payload=json.dumps({'kind':'text','text':{'private':__import__('sys').argv[1]}}).encode()
request=urllib.request.Request('http://localhost:8080/encode',payload,headers={'Content-Type':'application/json','X-Service-Token':os.environ['INTERNAL_TOKEN']})
try: urllib.request.urlopen(request)
except urllib.error.HTTPError as e: assert e.code==422
else: raise AssertionError('invalid body accepted')
"""
subprocess.run(['docker','compose','exec','-T','runtime','python','-c',probe,canary],check=True,capture_output=True)
bad=canary.encode()
invalid=a.create('otel-invalid.png',bad,'image/png');a.put(invalid,bad)
uploads=[]
for name,body,mime in [('otel-ocr.png',png,'image/png'),('otel-asr.mp3',audio,'audio/mpeg')]:
    trace=secrets.token_hex(16)
    headers={'traceparent':'00-'+trace+'-'+secrets.token_hex(8)+'-01','Authorization':'Bearer '+canary,'Cookie-Canary':canary}
    u=a.create(name,body,mime)
    a.put(u,body,headers=headers)
    uploads.append({'upload':u,'trace_id':trace})
    # Same body creates an actual dedup hit, and unaligned streaming download.
    dup=a.create(name,body,mime);a.put(dup,body)
    content=a.call('GET',f"/api/v1/assets/{u['asset_id']}/content",headers={'Range':'bytes=17-48'},expected=206)[2]
    assert content==body[17:49]
check('real uploads, deduplication and unaligned encrypted Range reads')
deadline=time.monotonic()+1200
while time.monotonic()<deadline:
    states=[]
    for item in uploads:
        u=item['upload']
        jobs=a.call('GET',f"/api/v1/assets/{u['asset_id']}/jobs")[2]['jobs']
        assert not any(j['status']=='failed' for j in jobs), 'media job failed'
        states.append(len(jobs)==2 and all(j['status']=='completed' for j in jobs))
    if all(states):break
    time.sleep(3)
else:raise AssertionError('media jobs timed out')
for mode in ['keyword','semantic','hybrid']:
    a.call('POST','/api/v1/search',{'query':'ORCHID','mode':mode,'limit':20})
a.call('POST','/api/v1/search',{'query':canary,'mode':'keyword','limit':20})
(root/'.cache/otel-workload.json').write_text(json.dumps({'uploads':uploads}))
secret=root/'.cache/otel-sensitive.json'
fd=os.open(secret,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'w') as f:json.dump([canary],f)
check('OCR, ASR, native image/audio embedding, keyword/semantic/hybrid search')

audit_events()
