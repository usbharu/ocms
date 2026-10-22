#!/usr/bin/env python3
"""Fault injection on the local development stack, after the regular integration suite.
Stops S3/PostgreSQL briefly. Never run against a shared environment.
"""
import base64
import json
import http.client
from urllib.parse import urlsplit
from pathlib import Path
import secrets
import uuid

from client import BASE, ORIGIN, Client, check, compose, sql
from integration import body

client = Client('alice')
upload = client.create('recovery-' + uuid.uuid4().hex + '.png', body)
# Fail Catalog's completion transaction after S3 and Transfer have committed.
sql("CREATE OR REPLACE FUNCTION catalog.integration_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$")
sql('CREATE TRIGGER integration_fail BEFORE INSERT ON catalog.outbox_events FOR EACH ROW EXECUTE FUNCTION catalog.integration_fail()')
try:
    client.put(upload, body, expected=503)
finally:
    sql('DROP TRIGGER integration_fail ON catalog.outbox_events')
    sql('DROP FUNCTION catalog.integration_fail()')
assert client.call('GET', f"/api/v1/uploads/{upload['upload_id']}")[2]['state'] == 'created'
client.put(upload, body)
asset = client.asset(upload)
blob = asset['blob_id']
path = f"/api/v1/assets/{upload['asset_id']}/content"
assert client.call('GET', path)[2] == body
check('S3/Transfer commit followed by Catalog transaction failure recovers on PUT retry')

new_upload = client.create('s3-failure.png', body)
try:
    compose('stop', 's3')
    client.put(new_upload, body, expected=503)
finally:
    compose('start', 's3')
    compose('up', '-d', '--wait')
client.put(new_upload, body)
assert client.asset(new_upload)['blob_id'] == blob
check('S3 outage and subsequent upload retry')
try:
    compose('stop', 'postgres')
    client.call('GET', '/api/v1/assets', expected=503)
finally:
    compose('start', 'postgres')
    compose('up', '-d', '--wait')
assert client.call('GET', path)[2] == body
check('PostgreSQL outage and connection recovery')

# An oversized chunked stream is encrypted into S3, then rejected by the size check.
# This produces a real uncommitted S3 object, rather than only a missing-object intent.
abandoned = client.create('abandoned.png', b'x')
cookie_handler = next(h for h in client.opener.handlers if hasattr(h, 'cookiejar'))
cookie = '; '.join(c.name + '=' + c.value for c in cookie_handler.cookiejar)
parsed = urlsplit(BASE)
connection = http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=30)
connection.request('PUT', f"/api/v1/uploads/{abandoned['upload_id']}/content", body=iter([b'xx']),
    headers={'Origin': ORIGIN, 'X-CSRF-Token': client.csrf, 'Cookie': cookie, 'Transfer-Encoding': 'chunked'}, encode_chunked=True)
response = connection.getresponse()
assert response.status == 400, response.read()
response.read(); connection.close()
intent = sql(f"SELECT id FROM storage.upload_objects WHERE upload_id='{abandoned['upload_id']}' AND state='writing'")
assert intent
sql(f"UPDATE storage.upload_objects SET created_at=now()-interval '2 hours' WHERE id='{intent}'")
compose('exec', '-T', 'transfer', 'ocms', 'reconcile')
assert sql(f"SELECT count(*) FROM storage.upload_objects WHERE id='{intent}'") == '0'
assert client.call('GET', path)[2] == body
check('actual abandoned S3 upload reconciliation and committed Blob preservation')

key_path = Path(__file__).resolve().parents[1] / 'secrets/crypto.yaml'
original = key_path.read_text()
old_active = original.splitlines()[0].split(':', 1)[1].strip()
new_id = 'verification-' + uuid.uuid4().hex
expanded = original + f'  {new_id}: "{base64.b64encode(secrets.token_bytes(32)).decode()}"\n'
rotated = expanded.replace('active_key_id: ' + old_active, 'active_key_id: ' + new_id, 1)
before = json.loads(compose('exec', '-T', 'transfer', 'ocms', 'ciphertext-info', blob))
try:
    key_path.write_text(rotated)
    compose('exec', '-T', 'transfer', 'ocms', 'rewrap')
    compose('restart', 'transfer')
    compose('up', '-d', '--wait')
    assert client.call('GET', path)[2] == body
    after = json.loads(compose('exec', '-T', 'transfer', 'ocms', 'ciphertext-info', blob))
    assert before == after
    assert sql(f"SELECT master_key_id FROM storage.blobs WHERE id='{blob}'") == new_id
    # Rewrap back before removing the temporary key.
    key_path.write_text(expanded)
    compose('exec', '-T', 'transfer', 'ocms', 'rewrap')
    key_path.write_text(original)
finally:
    # On failure the expanded keyring stays on disk so both generations remain readable.
    compose('restart', 'transfer')
    compose('up', '-d', '--wait')
assert client.call('GET', path)[2] == body
check('actual DB DEK rotation, unchanged S3 ciphertext, and restoration of original key generation')

# Check application logs for the generated local secrets; emit no sensitive values.
logs = compose('logs', '--no-color', 'bff', 'catalog', 'transfer', 'search', 'worker', 'runtime')
for line in (key_path.parent.parent / '.env').read_text().splitlines():
    if '=' in line:
        key, value = line.split('=', 1)
        if key.endswith(('PASSWORD', 'TOKEN', 'SECRET_KEY', 'ACCESS_KEY')):
            assert value not in logs, 'credential appeared in application logs'
for line in original.splitlines()[2:]:
    value = line.split(':', 1)[1].strip().strip('"')
    assert value not in logs, 'master key appeared in application logs'
check('application logs contain none of the generated credentials or master keys')
print('All recovery checks passed.')
