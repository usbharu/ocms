#!/usr/bin/env python3
"""Real WD14 inference, persistence, duplicate reuse, editable tags and ACL checks.
Run after media-integration.py has generated its synthetic fixtures.
"""
from pathlib import Path
import json
import time
import struct
import uuid
import zlib
from client import Client, check, sql

root = Path(__file__).resolve().parents[1]
fixtures = root / '.cache/fixtures'
alice, bob = Client('alice'), Client('bob')


def wait(upload):
    deadline = time.monotonic() + 2400
    while time.monotonic() < deadline:
        jobs = alice.call('GET', f"/api/v1/assets/{upload['asset_id']}/jobs")[2]['jobs']
        tagging = [j for j in jobs if j['job_type'] == 'tags.generate']
        assert not any(j['status'] == 'failed' for j in tagging), 'tagging job failed'
        if tagging and all(j['status'] == 'completed' for j in tagging):
            return alice.asset(upload)
        time.sleep(2)
    raise AssertionError('tagging deadline exceeded')


uploads = {}
bodies = {}
nonce = uuid.uuid4().hex.encode()
for name, mime in [('car.png', 'image/png'), ('car.mp4', 'video/mp4'), ('scan.pdf', 'application/pdf')]:
    data = (fixtures / name).read_bytes()
    # Valid metadata makes each run exercise fresh pipeline jobs, not only the cache.
    if mime == 'image/png':
        payload = b'tEXt' + b'wd14-test\x00' + nonce
        chunk = struct.pack('>I', len(payload)-4) + payload + struct.pack('>I', zlib.crc32(payload))
        data = data[:-12] + chunk + data[-12:]
    elif mime == 'video/mp4':
        data += struct.pack('>I', 8+len(nonce)) + b'free' + nonce
    else:
        data += b'\n% wd14-test-' + nonce + b'\n'
    bodies[name] = data
    upload = alice.create('wd14-fixture-' + name, data, mime)
    # Set manual tags before upload completion can trigger inference/reconciliation.
    alice.call('PATCH', f"/api/v1/assets/{upload['asset_id']}", {'tags': ['wd14-manual-alice']})
    alice.put(upload, data)
    uploads[name] = upload

for name, upload in uploads.items():
    asset = wait(upload)
    assert 'wd14-manual-alice' in asset['tags'], 'manual tag lost'
    blob = asset['blob_id']
    cached = json.loads(sql(f"SELECT array_to_json(tags) FROM catalog.wd14_results WHERE blob_id='{blob}'"))
    assert cached, 'synthetic visual fixture should receive general tags'
    assert set(cached).issubset(asset['tags']), 'inferred tags missing from asset'
    assert sql(f"SELECT bool_and(wd14_tagged)::text FROM catalog.assets WHERE id='{upload['asset_id']}'") == 'true'
    bob.call('GET', f"/api/v1/assets/{upload['asset_id']}", expected=404)
    term = cached[0]
    hits = alice.call('POST', '/api/v1/search', {'query': term, 'mode': 'keyword', 'limit': 200})[2]['assets']
    assert any(a['asset_id'] == upload['asset_id'] for a in hits), 'automatic tag not searchable'
    hits = bob.call('POST', '/api/v1/search', {'query': term, 'mode': 'keyword', 'limit': 200})[2]['assets']
    assert not any(a['asset_id'] == upload['asset_id'] for a in hits), 'search leaked asset'
    check('WD14 general tags persisted and searchable with ACL for ' + name)

source = uploads['car.png']
asset = alice.asset(source)
original_tags = set(asset['tags']) - {'wd14-manual-alice'}
expanded = asset['tags'] + ['wd14-edit-' + str(i) for i in range(110)]
alice.call('PATCH', f"/api/v1/assets/{source['asset_id']}", {'tags': expanded})
assert alice.asset(source)['tags'] == expanded, 'large combined tag set not editable'
# Remove auto tags and wait for reconciliation: they must not come back.
alice.call('PATCH', f"/api/v1/assets/{source['asset_id']}", {'tags': ['wd14-edited-alice']})
sql(f"UPDATE media.processing_jobs SET status='retry',attempts=0,available_at=now() WHERE source_blob_id='{asset['blob_id']}' AND job_type='tags.generate'")
wait(source)
time.sleep(5)
assert alice.asset(source)['tags'] == ['wd14-edited-alice']
body = bodies['car.png']
copy = bob.create('wd14-shared.png', body)
bob.put(copy, body)
deadline = time.monotonic() + 120
while time.monotonic() < deadline:
    copied = bob.asset(copy)
    if original_tags.issubset(copied['tags']):
        break
    time.sleep(2)
else:
    raise AssertionError('cached tags not applied to duplicate')
assert 'wd14-manual-alice' not in copied['tags'] and 'wd14-edited-alice' not in copied['tags']
assert copied['blob_id'] == asset['blob_id']
assert sql(f"SELECT count(*) FROM media.processing_jobs WHERE source_blob_id='{asset['blob_id']}' AND job_type='tags.generate'") == '1'
assert alice.asset(source)['tags'] == ['wd14-edited-alice']
check('duplicate reuses inference, manual edits remain independent and removed tags stay removed')

# A full manual tag list must remain editable and must never be truncated by tagging.
capped = bob.create('wd14-full-tags.png', body)
manual = ['wd14-manual-' + str(i) for i in range(512)]
bob.call('PATCH', f"/api/v1/assets/{capped['asset_id']}", {'tags': manual})
bob.put(capped, body)
deadline = time.monotonic() + 120
while time.monotonic() < deadline:
    if sql(f"SELECT wd14_tagged::text FROM catalog.assets WHERE id='{capped['asset_id']}'") == 'true':
        break
    time.sleep(2)
else:
    raise AssertionError('full tag list was not reconciled')
assert bob.asset(capped)['tags'] == manual
bob.call('PATCH', f"/api/v1/assets/{capped['asset_id']}", {'tags': manual + ['too-many']}, expected=400)
check('combined 512-tag limit preserves existing manual tags and rejects overflow')
print('All WD14 tagging checks passed.', flush=True)
