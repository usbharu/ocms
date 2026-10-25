#!/usr/bin/env python3
"""Verify per-user favorites with synthetic rows on the development stack."""
import uuid
from concurrent.futures import ThreadPoolExecutor
from client import Client, sql, check

alice, bob = Client('alice'), Client('bob')
aid, bid = alice.me['principal_id'], bob.me['principal_id']
prefix = 'favorite-' + uuid.uuid4().hex
ids = [str(uuid.uuid4()) for _ in range(205)]
blob = str(uuid.uuid4())
quoted = ','.join("'" + x + "'" for x in ids)

def favorite(client, index, method='PUT', expected=204):
    return client.call(method, '/api/v1/assets/' + ids[index] + '/favorite', expected=expected)

def listing(client=alice, query=''):
    return client.call('GET', '/api/v1/assets?favorites=true&q=' + prefix + query)[2]

try:
    sql("INSERT INTO catalog.assets(id,owner_id,filename,mime_type) VALUES " + ','.join(
        f"('{x}','{bid if i == 2 else aid}','{prefix}-{i}','{'audio/ogg' if i == 1 else 'image/png'}')"
        for i, x in enumerate(ids)))
    sql(f"INSERT INTO catalog.asset_originals(asset_id,blob_id) VALUES ('{ids[0]}','{blob}'),('{ids[1]}','{blob}');")
    Client().call('GET', '/api/v1/assets?favorites=true', expected=401)
    favorite(bob, 0, expected=404)
    favorite(alice, 2, expected=404)
    alice.call('PUT', '/api/v1/assets/' + ids[0] + '/favorite', headers={'X-CSRF-Token': ''}, expected=403)
    alice.call('PUT', '/api/v1/assets/' + ids[0] + '/favorite', headers={'Origin': 'https://invalid.example'}, expected=403)
    favorite(alice, 0)
    stamp = sql(f"SELECT created_at FROM catalog.asset_favorites WHERE asset_id='{ids[0]}'")
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda _: favorite(alice, 0), range(8)))
    assert sql(f"SELECT created_at FROM catalog.asset_favorites WHERE asset_id='{ids[0]}'") == stamp
    assert alice.call('GET', '/api/v1/assets/' + ids[0])[2]['is_favorite']
    assert not alice.call('GET', '/api/v1/assets/' + ids[1])[2]['is_favorite']
    assert listing(Client('alice'))['total'] == 1
    assert listing(bob)['total'] == 0
    sql(f"INSERT INTO catalog.grants VALUES ('{ids[0]}','{bid}','read')")
    assert not bob.call('GET', '/api/v1/assets/' + ids[0])[2]['is_favorite']
    favorite(bob, 0)
    favorite(alice, 0, 'DELETE')
    favorite(alice, 0, 'DELETE')
    assert listing(bob)['total'] == 1 and listing()['total'] == 0
    favorite(alice, 0)
    assert sql(f"SELECT created_at FROM catalog.asset_favorites WHERE principal_id='{aid}' AND asset_id='{ids[0]}'") != stamp
    sql(f"DELETE FROM catalog.grants WHERE asset_id='{ids[0]}' AND principal_id='{bid}'")
    assert listing(bob)['total'] == 0
    favorite(bob, 0, 'DELETE', expected=404)
    sql(f"INSERT INTO catalog.grants VALUES ('{ids[0]}','{bid}','read')")
    assert listing(bob)['total'] == 1
    # Seed more than the public result limit: filtering must happen before LIMIT.
    sql(f"INSERT INTO catalog.asset_favorites(principal_id,asset_id) SELECT '{aid}',id FROM catalog.assets WHERE id IN ({quoted}) AND owner_id='{aid}' ON CONFLICT DO NOTHING;")
    sql(f"UPDATE catalog.asset_favorites SET created_at='2020-01-01' WHERE principal_id='{aid}' AND asset_id IN ({quoted}); UPDATE catalog.asset_favorites SET created_at='2021-01-01' WHERE principal_id='{aid}' AND asset_id='{ids[1]}';")
    result = listing(query='&limit=24')
    assert result['total'] == 204 and len(result['assets']) == 24 and result['assets'][0]['asset_id'] == ids[1]
    assert listing(query='&kind=audio')['total'] == 1
    assert len(listing(query='&offset=192&limit=24')['assets']) == 12
    assert all(a['is_favorite'] for a in result['assets'])
    favorite(alice, 1, 'DELETE')
    duplicates = alice.call('GET', '/api/v1/assets/' + ids[0] + '/duplicates?favorites=true')[2]['assets']
    assert not duplicates
    sql(f"UPDATE catalog.assets SET deleted_at=now() WHERE id='{ids[0]}'")
    assert listing(bob)['total'] == 0
    favorite(alice, 0, expected=404)
    for value in ('yes', '', 'true&favorites=false'):
        alice.call('GET', '/api/v1/assets?favorites=' + value, expected=400)
    # Filename-only matches must retain the favorite Asset beyond 200 ordinary matches.
    sql(f"DELETE FROM catalog.asset_favorites WHERE principal_id='{aid}' AND asset_id IN ({quoted});")
    favorite(alice, 204)
    result = alice.call('POST', '/api/v1/search', {'query': prefix, 'mode': 'keyword', 'favorites': True, 'limit': 1})[2]
    assert [a['asset_id'] for a in result['assets']] == [ids[204]]
    check('favorites: user/Asset independence, read grants, CSRF, persistence, idempotency, ordering, pagination, kind, deleted/revoked ACL and keyword scope before limit')
finally:
    sql(f"DELETE FROM catalog.asset_favorites WHERE asset_id IN ({quoted}); DELETE FROM catalog.grants WHERE asset_id IN ({quoted}); DELETE FROM catalog.asset_originals WHERE asset_id IN ({quoted}); DELETE FROM catalog.assets WHERE id IN ({quoted});")
