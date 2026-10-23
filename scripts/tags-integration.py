#!/usr/bin/env python3
"""Verify tag counts, graph co-occurrence, exact filtering and ACL using synthetic rows."""
import uuid
from urllib.parse import quote
from client import Client, sql, check

alice, bob = Client('alice'), Client('bob')
aid = str(uuid.UUID(alice.me['principal_id']))
bid = str(uuid.UUID(bob.me['principal_id']))
prefix = 'tag-browser-' + uuid.uuid4().hex
ids = [str(uuid.uuid4()) for _ in range(5)]
a, b, hidden = prefix + '-a', prefix + '-b', prefix + '-hidden'
try:
    sql(f"""INSERT INTO catalog.assets(id,owner_id,filename,mime_type,tags) VALUES
        ('{ids[0]}','{aid}','{prefix}-1','image/png',ARRAY['{a}','{a}','{b}']),
        ('{ids[1]}','{aid}','{prefix}-2','image/png',ARRAY['{a}']),
        ('{ids[2]}','{bid}','{prefix}-3','image/png',ARRAY['{a}','{b}']),
        ('{ids[3]}','{bid}','{prefix}-4','image/png',ARRAY['{a}','{hidden}']),
        ('{ids[4]}','{aid}','{prefix}-5','image/png',ARRAY['{hidden}']);
        UPDATE catalog.assets SET deleted_at=now() WHERE id='{ids[4]}';
        INSERT INTO catalog.grants(asset_id,principal_id,permission)
        VALUES ('{ids[2]}','{aid}','read');""")
    result = alice.call('GET', '/api/v1/tags?q=' + prefix)[2]
    assert result['total'] == 2
    assert result['tags'] == [{'name': a, 'asset_count': 3}, {'name': b, 'asset_count': 2}]
    assert result['links'] == [{'source': a, 'target': b, 'asset_count': 2}]
    assert bob.call('GET', '/api/v1/tags?q=' + prefix)[2]['total'] == 3
    assert alice.call('GET', '/api/v1/tags?q=' + prefix.upper())[2] == result
    assert alice.call('GET', '/api/v1/tags?q=' + hidden)[2] == {'tags': [], 'links': [], 'total': 0}
    result = alice.call('GET', '/api/v1/assets?tag=' + quote(a) + '&limit=2')[2]
    assert result['total'] == 3 and len(result['assets']) == 2
    assert alice.call('GET', '/api/v1/assets?tag=' + quote(a) + '&offset=2')[2]['total'] == 3
    assert alice.call('GET', '/api/v1/assets?tag=' + prefix)[2]['total'] == 0
    alice.call('PATCH', '/api/v1/assets/' + ids[1], {'tags': [b]})
    counts = alice.call('GET', '/api/v1/tags?q=' + prefix)[2]['tags']
    assert counts == [{'name': b, 'asset_count': 3}, {'name': a, 'asset_count': 2}]
    alice.call('DELETE', '/api/v1/assets/' + ids[0], expected=204)
    assert alice.call('GET', '/api/v1/tags?q=' + prefix)[2]['links'][0]['asset_count'] == 1
    # Exercise result and graph caps without uploads or media processing.
    sql(f"UPDATE catalog.assets SET tags=ARRAY(SELECT '{prefix}-many-' || i FROM generate_series(1,210) i) WHERE id='{ids[1]}';")
    result = alice.call('GET', '/api/v1/tags?q=' + prefix + '-many-')[2]
    assert result['total'] == 210 and len(result['tags']) == 200
    assert len(result['links']) == 60 * 59 // 2
    graph_names = {tag['name'] for tag in result['tags'][:60]}
    assert all(link['source'] in graph_names and link['target'] in graph_names for link in result['links'])
    Client().call('GET', '/api/v1/tags', expected=401)
    check('tag counts, duplicate labels, graph edges, read grants, private/deleted exclusion, exact tag pagination, edits and caps')
finally:
    quoted_ids = ','.join("'" + value + "'" for value in ids)
    sql(f"DELETE FROM catalog.grants WHERE asset_id IN ({quoted_ids}); DELETE FROM catalog.assets WHERE id IN ({quoted_ids});")
