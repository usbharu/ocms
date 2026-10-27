#!/usr/bin/env python3
"""Real Compose storage integration checks."""
import concurrent.futures
import hashlib
import json
import uuid
from client import Client, compose, sql, check

anon = Client()
anon.call('GET', '/api/v1/assets', expected=401)
a = Client('alice'); b = Client('bob')
a.call('POST', '/api/v1/uploads', {}, headers={'X-CSRF-Token': ''}, expected=403)
a.call('POST', '/api/v1/uploads', {}, headers={'Origin': 'https://invalid.example'}, expected=403)
check('session authentication and CSRF')
key = uuid.uuid4().hex
payload = {'filename': 'idempotent.png', 'mime_type': 'image/png', 'size_bytes': 0}
first = a.call('POST', '/api/v1/uploads', payload, headers={'Idempotency-Key': key}, expected=201)[2]
assert a.call('POST', '/api/v1/uploads', payload, headers={'Idempotency-Key': key}, expected=201)[2] == first
a.call('POST', '/api/v1/uploads', {**payload, 'size_bytes': 1}, headers={'Idempotency-Key': key}, expected=409)
assert b.call('POST', '/api/v1/uploads', payload, headers={'Idempotency-Key': key}, expected=201)[2]['upload_id'] != first['upload_id']
check('user-scoped session creation idempotency and conflict detection')

# Unique synthetic bytes avoid coupling the checks to previous runs.
body = b'\x89PNG\r\n\x1a\n' + uuid.uuid4().bytes + bytes(range(256)) * 4096
name = 'test-' + uuid.uuid4().hex
u = a.create(name + '.png', body); a.put(u, body)
asset = a.asset(u); blob = asset['blob_id']; path = f"/api/v1/assets/{u['asset_id']}/content"
assert a.call('GET', path)[2] == body
headers = a.call('HEAD', path)[1]
assert int(headers['Content-Length']) == len(body) and headers['Accept-Ranges'] == 'bytes'
for start, end in [(0, 0), (1, 31), (15, 32), (17, 8193), (len(body)-19, len(body)-1)]:
    _, h, content = a.call('GET', path, headers={'Range': f'bytes={start}-{end}'}, expected=206)
    assert content == body[start:end+1]
    assert h['Content-Range'] == f'bytes {start}-{end}/{len(body)}'
assert a.call('GET', path, headers={'Range': 'bytes=-17'}, expected=206)[2] == body[-17:]
assert a.call('GET', path, headers={'Range': f'bytes={len(body)}-'}, expected=416)[1]['Content-Range'] == f'bytes */{len(body)}'
assert a.call('GET', path, headers={'Range': 'bytes=0-3,8-9'})[2] == body
assert a.call('GET', path, headers={'Range': 'bytes=2-7', 'If-Range': '"other"'})[2] == body
assert a.call('GET', path, headers={'Range': 'bytes=2-7', 'If-Range': headers['ETag']}, expected=206)[2] == body[2:8]
check('full read, HEAD, unaligned/suffix/invalid/multipart Range and If-Range')
cipher_info = json.loads(compose('exec', '-T', 'transfer', 'ocms', 'ciphertext-info', blob))
assert cipher_info['size_bytes'] == len(body)
assert cipher_info['sha256'] != hashlib.sha256(body).hexdigest()
check('actual S3 object contains same-length ciphertext')
# Same owner, name and content resolve to one Asset even under concurrency.
matching = [a.create(name + '.png', body) for _ in range(4)]
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
    results = list(executor.map(lambda item: a.call('PUT', f"/api/v1/uploads/{item['upload_id']}/content", body)[2], matching))
assert all(result['asset_id'] == u['asset_id'] for result in results)
assert all(a.call('GET', f"/api/v1/uploads/{item['upload_id']}")[2]['asset_id'] == u['asset_id'] for item in matching)
other = b.create(name + '.png', body)
assert b.call('PUT', f"/api/v1/uploads/{other['upload_id']}/content", body)[2]['asset_id'] == other['asset_id']
different = a.create(name + '.png', body + b'x')
assert a.call('PUT', f"/api/v1/uploads/{different['upload_id']}/content", body + b'x')[2]['asset_id'] == different['asset_id']
check('same-owner exact duplicates reuse an Asset; other owners and different content remain separate')
# Independent users upload the same bytes concurrently.
sessions = [(a if i % 2 == 0 else b, (a if i % 2 == 0 else b).create(name + f'-copy-{i}.png', body)) for i in range(8)]
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
    list(executor.map(lambda pair: pair[0].put(pair[1], body), sessions))
assert all(client.asset(item)['blob_id'] == blob for client, item in sessions)
assert sql(f"SELECT count(*) FROM storage.blobs WHERE id='{blob}'") == '1'
assert sql(f"SELECT count(*) FROM catalog.outbox_events WHERE blob_id='{blob}'") == '1'
# A repeated PUT uses the already committed result.
a.put(u, body)
check('concurrent cross-user deduplication, idempotent PUT, single outbox event')
b.call('GET', path, expected=404)
b.call('GET', f"/api/v1/assets/{u['asset_id']}", expected=404)
b.call('DELETE', f"/api/v1/assets/{u['asset_id']}", expected=404)
a.call('GET', '/api/v1/assets/' + str(uuid.uuid4()), expected=404)
_, _, found = b.call('POST', '/api/v1/search', {'mode': 'keyword', 'query': name})
assert u['asset_id'] not in {x['asset_id'] for x in found['assets']}
dup = a.call('GET', f"/api/v1/assets/{u['asset_id']}/duplicates")[2]['assets']
assert len(dup) == 4
b.call('GET', path, headers={'X-Principal': a.me['principal_id'], 'X-Service-Token': 'forged'}, expected=404)
check('ACL isolation in content, details, delete, search, duplicates and forged headers')
a.call('PATCH', f"/api/v1/assets/{u['asset_id']}", {'tags': [name + '-タグ'], 'filename': name + '-renamed.png'})
assert {item['asset_id'] for item in a.call('POST', '/api/v1/search', {'mode': 'keyword', 'query': name + '-タグ'})[2]['assets']} == {u['asset_id']}
a.call('POST', '/api/v1/search', {'mode': 'unsupported', 'query': 'test'}, expected=400)
check('filename/tag editing and search, unavailable modes explicitly rejected')
wrong = a.create('wrong.png', b'1234'); a.put(wrong, b'123', expected=400)
empty = a.create('empty.png', b''); a.put(empty, b''); assert a.call('GET', f"/api/v1/assets/{empty['asset_id']}/content")[2] == b''
check('size mismatch rejected, empty Blob roundtrip')
a.call('DELETE', f"/api/v1/assets/{u['asset_id']}", expected=204)
a.call('GET', path, expected=404)
assert b.call('GET', f"/api/v1/assets/{sessions[1][1]['asset_id']}/content")[2] == body
check('logical deletion preserves another owner\'s shared Blob')
# Roles must not cross-write the other service's schema.
assert sql("SELECT has_schema_privilege('catalog_app','storage','USAGE') OR has_schema_privilege('transfer_app','catalog','USAGE')") == 'f'
check('database schema privilege separation')
print('All Compose integration checks passed.')
