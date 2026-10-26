#!/usr/bin/env python3
"""HTTP cache checks with synthetic bytes and seeded renditions on the dev stack."""
import re
import uuid
from client import Client, sql, check


def assert_policy(headers, policy):
    assert headers.get_all('Cache-Control') == [policy]


anon = Client()
_, headers, html = anon.call('GET', '/')
assert_policy(headers, 'public, no-cache')
anon.call('GET', '/', headers={'If-None-Match': headers['ETag']}, expected=304)
static_paths = re.findall(r'(?:src|href)="(/assets/[^"?]+)"', html.decode())
assert static_paths, 'Vite assets missing from static build'
for path in static_paths:
    _, h, _ = anon.call('GET', path)
    assert_policy(h, 'public, max-age=31536000, immutable')
    anon.call('GET', path, headers={'If-None-Match': h['ETag']}, expected=304)
_, h, _ = anon.call('GET', '/assets/missing-12345678.js', expected=404)
assert_policy(h, 'private, no-store')
check('static HTML revalidation, immutable Vite assets and non-cacheable errors')

owner = Client('alice')
reader = Client('bob')
fixtures = []
for label in ['source', 'page-1', 'page-2']:
    body = label.encode() + uuid.uuid4().bytes
    upload = owner.create('cache-' + uuid.uuid4().hex + '.png', body)
    owner.put(upload, body)
    fixtures.append((upload, owner.asset(upload), body))

upload, source, original = fixtures[0]
asset_id = upload['asset_id']
rendition_ids = [str(uuid.uuid4()), str(uuid.uuid4())]
try:
    for page, rendition_id in enumerate(rendition_ids, 1):
        output = fixtures[page][1]['blob_id']
        sql(f"INSERT INTO media.renditions(id,source_blob_id,output_blob_id,profile_id,encoder_version,mime_type) VALUES('{rendition_id}','{source['blob_id']}','{output}','pdf.page-{page}-v1','cache-test','image/png')")

    root = f'/api/v1/assets/{asset_id}'
    paths = {
        root + '/content': original,
        root + '/preview': fixtures[1][2],
        root + '/preview?page=2': fixtures[2][2],
        root + f'/renditions/{rendition_ids[0]}/content': fixtures[1][2],
        root + f'/renditions/{rendition_ids[1]}/content': fixtures[2][2],
    }
    etags = {}
    for path, body in paths.items():
        _, headers, content = owner.call('GET', path)
        assert content == body
        assert_policy(headers, 'private, no-cache')
        assert 'Cookie' in headers.get('Vary', '')
        etag = etags[path] = headers['ETag']
        for method in ['GET', 'HEAD']:
            for validator in [etag, 'W/' + etag, '"old", W/' + etag, '*']:
                _, h, content = owner.call(method, path, headers={
                    'If-None-Match': validator, 'Range': 'bytes=99999999-',
                }, expected=304)
                assert content == b'' and h['ETag'] == etag
                assert h.get('Content-Range') is None
                assert_policy(h, 'private, no-cache')
        assert owner.call('GET', path, headers={'If-None-Match': '"old"'})[2] == body
        _, h, content = owner.call('GET', path, headers={
            'If-None-Match': '"old"', 'Range': 'bytes=1-3', 'If-Range': etag,
        }, expected=206)
        assert content == body[1:4]
        assert_policy(h, 'private, no-cache')
        _, h, _ = owner.call('GET', path, headers={'Range': 'bytes=99999999-'}, expected=416)
        assert_policy(h, 'private, no-store')
    assert etags[root + '/preview'] != etags[root + '/preview?page=2']
    assert owner.call('GET', root + '/preview?page=2', headers={
        'If-None-Match': etags[root + '/preview'],
    })[2] == fixtures[2][2]
    for missing in [root + '/preview?page=3', root + f'/renditions/{uuid.uuid4()}/content']:
        _, h, _ = owner.call('GET', missing, headers={'If-None-Match': '*'}, expected=404)
        assert_policy(h, 'private, no-store')
    check('original, preview pages and renditions: validators, 304, Range and errors')

    for path in paths:
        _, h, _ = anon.call('GET', path, headers={'If-None-Match': etags[path]}, expected=401)
        assert_policy(h, 'private, no-store')
        _, h, _ = reader.call('GET', path, headers={'If-None-Match': '*'}, expected=404)
        assert_policy(h, 'private, no-store')
    principal = reader.me['principal_id']
    sql(f"INSERT INTO catalog.grants(asset_id,principal_id,permission) VALUES('{asset_id}','{principal}','read')")
    for path in paths:
        reader.call('GET', path, headers={'If-None-Match': etags[path]}, expected=304)
    sql(f"DELETE FROM catalog.grants WHERE asset_id='{asset_id}' AND principal_id='{principal}'")
    for path in paths:
        _, h, _ = reader.call('GET', path, headers={'If-None-Match': etags[path]}, expected=404)
        assert_policy(h, 'private, no-store')
    owner.call('POST', '/auth/logout', expected=204)
    for path in paths:
        owner.call('GET', path, headers={'If-None-Match': etags[path]}, expected=401)
    owner = Client('alice')
    owner.call('DELETE', root, expected=204)
    for path in paths:
        _, h, _ = owner.call('GET', path, headers={'If-None-Match': etags[path]}, expected=404)
        assert_policy(h, 'private, no-store')
    check('revalidation enforces session, ACL grant/revocation, logout and deletion')
finally:
    ids = ','.join("'" + value + "'" for value in rendition_ids)
    sql(f'DELETE FROM media.renditions WHERE id IN ({ids})')

print('All HTTP cache integration checks passed.')
