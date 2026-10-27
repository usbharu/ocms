#!/usr/bin/env python3
"""Media lease, ACL and retry checks on the local Compose stack."""
import json
import os
from pathlib import Path
import struct
import subprocess
import time
import uuid
import zlib
from client import Client, compose, sql, check

root=Path(__file__).resolve().parents[1]
a,b=Client('alice'),Client('bob')
source=json.loads((root/'.cache/media-uploads.json').read_text())['car.png']
asset=a.asset(source);blob=asset['blob_id']
compose('exec','-T','worker','sh','-c','test ! -e /run/secrets/crypto.yaml && test -z "$S3_SECRET_KEY"')
check('Worker has neither YAML master keys nor S3 credentials')

job,lease=str(uuid.uuid4()),str(uuid.uuid4())
sql(f"INSERT INTO media.processing_jobs(id,event_id,source_blob_id,job_type,pipeline_version,status,attempts,lease_token,locked_until) VALUES('{job}',gen_random_uuid(),'{blob}','media.process',99,'running',4,'{lease}',now()+interval '10 minutes')")
code='''import json,os,sys,urllib.request,urllib.error
p=json.load(sys.stdin)
req=urllib.request.Request(p['url'],headers={'X-Service-Token':os.environ['INTERNAL_TOKEN'],'X-Job-ID':p['job'],'X-Job-Lease':p['lease']})
try:r=urllib.request.urlopen(req,timeout=30)
except urllib.error.HTTPError as e:r=e
print(r.code);r.close()
'''
def internal(blob_id, job_id, lease_token):
    payload={'url':f'http://transfer:8080/internal/blobs/{blob_id}/content','job':job_id,'lease':lease_token}
    result=subprocess.run(['docker','compose','exec','-T','runtime','python','-c',code],input=json.dumps(payload).encode(),capture_output=True,check=True)
    return int(result.stdout)
try:
    assert internal(blob,job,lease)==200
    assert internal(str(uuid.uuid4()),job,lease)==403
    assert internal(blob,job,str(uuid.uuid4()))==403
    sql(f"UPDATE media.processing_jobs SET locked_until=now()-interval '1 second' WHERE id='{job}'")
    assert internal(blob,job,lease)==403
finally:
    sql(f"DELETE FROM media.processing_jobs WHERE id='{job}'")
check('Transfer checks live Job, exact source Blob, lease token and expiry')

# Read-only sharing allows derived reads, but not initiating new work.
u=a.create('acl-read-only.png',(root/'.cache/fixtures/car.png').read_bytes())
a.put(u,(root/'.cache/fixtures/car.png').read_bytes())
try:
    sql(f"INSERT INTO catalog.grants(asset_id,principal_id,permission) VALUES('{u['asset_id']}','{b.me['principal_id']}','read')")
    assert b.call('GET',f"/api/v1/assets/{u['asset_id']}/renditions")[2]['renditions']
    b.call('POST',f"/api/v1/assets/{u['asset_id']}/renditions",{},expected=404)
finally:
    sql(f"DELETE FROM catalog.grants WHERE asset_id='{u['asset_id']}'")
    a.call('DELETE',f"/api/v1/assets/{u['asset_id']}",expected=204)
check('read-only grant permits viewing but cannot initiate transcoding')

# Add a harmless PNG metadata chunk so this valid image has a fresh source Blob.
image=(root/'.cache/fixtures/car.png').read_bytes()
payload=b'Comment\0retry-'+uuid.uuid4().hex.encode()
chunk=struct.pack('>I',len(payload))+b'tEXt'+payload+struct.pack('>I',zlib.crc32(b'tEXt'+payload)&0xffffffff)
image=image[:-12]+chunk+image[-12:]
u=a.create('retry-valid.png',image)
try:
    compose('stop','search')
    a.put(u,image)
    deadline=time.monotonic()+240
    while time.monotonic()<deadline:
        jobs=a.call('GET',f"/api/v1/assets/{u['asset_id']}/jobs")[2]['jobs']
        if any(j['job_type']=='media.process' and j['attempts']>=1 and j['status'] in ('retry','failed') for j in jobs):
            break
        time.sleep(2)
    else:raise AssertionError('expected media job failure with Search stopped')
finally:
    compose('start','search')
    compose('up','-d','--wait','search')
# Request is also the explicit recovery path for a terminal failure.
a.call('POST',f"/api/v1/assets/{u['asset_id']}/renditions",{},expected=202)
deadline=time.monotonic()+240
while time.monotonic()<deadline:
    jobs=a.call('GET',f"/api/v1/assets/{u['asset_id']}/jobs")[2]['jobs']
    required={'media.process','embedding.generate'}
    if required <= {j['job_type'] for j in jobs} and all(j['status']=='completed' for j in jobs):break
    time.sleep(2)
else:raise AssertionError(jobs)
assert a.asset(u)['status']=='ready'
blob=a.asset(u)['blob_id']
assert sql(f"SELECT count(*)=count(DISTINCT profile_id) FROM media.renditions WHERE source_blob_id='{blob}'")=='t'
check('Search outage → media retry → ready; derivative retries reuse existing output')
print('All media job recovery checks passed.')
