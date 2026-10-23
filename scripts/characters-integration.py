#!/usr/bin/env python3
"""Verify character counts, graph co-occurrence, exact filtering and ACL using synthetic rows."""
import uuid
import json
import subprocess
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote
from client import Client, sql, check

alice, bob = Client('alice'), Client('bob')
aid = str(uuid.UUID(alice.me['principal_id']))
bid = str(uuid.UUID(bob.me['principal_id']))
prefix = 'character-browser-' + uuid.uuid4().hex
ids = [str(uuid.uuid4()) for _ in range(8)]
blob, job, lease = [str(uuid.uuid4()) for _ in range(3)]

def internal(path, body, expected=204, job_lease=None):
    # Service credentials stay inside the container and never enter command output.
    program = '''import json,os,sys,urllib.request,urllib.error
item=json.load(sys.stdin)
headers={'Content-Type':'application/json','X-Service-Token':os.environ['INTERNAL_TOKEN'],
         'X-Job-ID':item['job'],'X-Job-Lease':item['lease']}
try:
 response=urllib.request.urlopen(urllib.request.Request('http://catalog:8080'+item['path'],data=json.dumps(item['body']).encode(),headers=headers,method='POST'))
 status=response.status
except urllib.error.HTTPError as e: status=e.code
assert status==item['expected'], 'unexpected internal API status: '+str(status)
'''
    subprocess.run(['docker','compose','exec','-T','runtime','python','-c',program],
                   input=json.dumps({'path':path,'body':body,'expected':expected,'job':job,'lease':job_lease or lease}).encode(),check=True,capture_output=True)

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
    sql(f"""INSERT INTO catalog.asset_characters(asset_id,name,position)
      SELECT id,name,n FROM catalog.assets CROSS JOIN LATERAL unnest(tags) WITH ORDINALITY c(name,n)
      WHERE id IN ({','.join("'" + x + "'" for x in ids)}) ON CONFLICT DO NOTHING;""")
    result = alice.call('GET', '/api/v1/characters?q=' + prefix)[2]
    assert result['total'] == 2
    assert result['characters'] == [{'name': a, 'asset_count': 3}, {'name': b, 'asset_count': 2}]
    assert result['links'] == [{'source': a, 'target': b, 'asset_count': 2}]
    assert bob.call('GET', '/api/v1/characters?q=' + prefix)[2]['total'] == 3
    assert alice.call('GET', '/api/v1/characters?q=' + prefix.upper())[2] == result
    assert alice.call('GET', '/api/v1/characters?q=' + hidden)[2] == {'characters': [], 'links': [], 'total': 0}
    result = alice.call('GET', '/api/v1/assets?character=' + quote(a) + '&limit=2')[2]
    assert result['total'] == 3 and len(result['assets']) == 2
    assert alice.call('GET', '/api/v1/assets?character=' + quote(a) + '&offset=2')[2]['total'] == 3
    assert alice.call('GET', '/api/v1/assets?character=' + prefix)[2]['total'] == 0
    alice.call('PATCH', '/api/v1/assets/' + ids[1], {'characters': [b]})
    assert alice.call('GET', '/api/v1/assets/' + ids[1])[2]['tags'] == [a]
    alice.call('PATCH', '/api/v1/assets/' + ids[2], {'characters': [hidden]}, expected=404)
    alice.call('PATCH', '/api/v1/assets/' + ids[1], {'characters': [' ']}, expected=400)
    assert alice.call('GET', '/api/v1/assets?q=' + quote(b))[2]['total'] >= 3
    counts = alice.call('GET', '/api/v1/characters?q=' + prefix)[2]['characters']
    assert counts == [{'name': b, 'asset_count': 3}, {'name': a, 'asset_count': 2}]
    alice.call('DELETE', '/api/v1/assets/' + ids[0], expected=204)
    assert alice.call('GET', '/api/v1/characters?q=' + prefix)[2]['links'][0]['asset_count'] == 1
    # Exercise result and graph caps without uploads or media processing.
    sql(f"DELETE FROM catalog.asset_characters WHERE asset_id='{ids[1]}'; INSERT INTO catalog.asset_characters SELECT '{ids[1]}','{prefix}-many-' || i,i FROM generate_series(1,210) i;")
    result = alice.call('GET', '/api/v1/characters?q=' + prefix + '-many-')[2]
    assert result['total'] == 210 and len(result['characters']) == 200
    assert len(result['links']) == 60 * 59 // 2
    graph_names = {tag['name'] for tag in result['characters'][:60]}
    assert all(link['source'] in graph_names and link['target'] in graph_names for link in result['links'])
    Client().call('GET', '/api/v1/characters', expected=401)
    check('character independence, counts, duplicate labels, graph edges, read grants, private/deleted exclusion, exact character pagination, edits and caps')
    # Exercise the real authorized inference-result API with a synthetic prediction.
    # Positive character fixtures are deterministic; real model inference is tested separately.
    sql(f"""INSERT INTO catalog.assets(id,owner_id,filename,mime_type,tags) VALUES
      ('{ids[5]}','{aid}','{prefix}-inference','image/png',ARRAY['manual-tag']),
      ('{ids[6]}','{bid}','{prefix}-full','image/png',ARRAY[]::text[]);
      INSERT INTO catalog.asset_originals(asset_id,blob_id) VALUES ('{ids[5]}','{blob}'),('{ids[6]}','{blob}');
      INSERT INTO media.processing_jobs(id,event_id,source_blob_id,job_type,status,lease_token,locked_until)
      VALUES ('{job}',gen_random_uuid(),'{blob}','tags.generate','running','{lease}',now()+interval '1 hour');""")
    alice.call('PATCH', '/api/v1/assets/' + ids[5], {'characters': ['manual-character','user-only-character']})
    full = ['manual-' + str(i) for i in range(512)]
    bob.call('PATCH', '/api/v1/assets/' + ids[6], {'characters': full})
    prediction = {'tags': ['auto-tag'], 'characters': ['auto-character','manual-character'],
                  'model_id': 'SmilingWolf/wd-v1-4-convnext-tagger-v2',
                  'model_revision': '4b34d1b07bdd8e95494072648960b8a6adcbc0ff'}
    internal('/internal/blobs/' + blob + '/tags', prediction, expected=403, job_lease=str(uuid.uuid4()))
    assert sql(f"SELECT count(*) FROM catalog.wd14_character_results WHERE blob_id='{blob}'") == '0'
    internal('/internal/blobs/' + blob + '/tags', prediction)
    assert alice.call('GET', '/api/v1/assets/' + ids[5])[2]['characters'] == ['manual-character','user-only-character','auto-character']
    assert bob.call('GET', '/api/v1/assets/' + ids[6])[2]['characters'] == full
    bob.call('PATCH', '/api/v1/assets/' + ids[6], {'characters': full + ['overflow']}, expected=400)
    alice.call('PATCH', '/api/v1/assets/' + ids[5], {'characters': []})
    internal('/internal/blobs/' + blob + '/tags', prediction)
    assert alice.call('GET', '/api/v1/assets/' + ids[5])[2]['characters'] == []
    sql(f"""INSERT INTO catalog.assets(id,owner_id,filename,mime_type) VALUES ('{ids[7]}','{bid}','{prefix}-duplicate','image/png');
      INSERT INTO catalog.asset_originals(asset_id,blob_id) VALUES ('{ids[7]}','{blob}');""")
    internal('/internal/blobs/' + blob + '/state', {'status': 'ready'})
    assert bob.call('GET', '/api/v1/assets/' + ids[7])[2]['characters'] == prediction['characters']
    assert alice.call('GET', '/api/v1/assets/' + ids[5])[2]['characters'] == []
    assert bob.call('GET', '/api/v1/assets/' + ids[6])[2]['characters'] == full
    assert sql(f"SELECT count(*) FROM catalog.wd14_character_results WHERE blob_id='{blob}'") == '1'
    # Manual edits and inference serialize on the Asset row, including the cap.
    with ThreadPoolExecutor(max_workers=2) as pool:
        for _ in range(4):
            alice.call('PATCH', '/api/v1/assets/' + ids[5], {'characters': []})
            sql(f"UPDATE catalog.assets SET wd14_characters_tagged=false WHERE id='{ids[5]}';")
            edit = pool.submit(alice.call, 'PATCH', '/api/v1/assets/' + ids[5], {'characters': full})
            apply = pool.submit(internal, '/internal/blobs/' + blob + '/state', {'status': 'ready'})
            edit.result()
            apply.result()
            assert alice.call('GET', '/api/v1/assets/' + ids[5])[2]['characters'] == full
    check('authorized inference persistence, separate cache, manual preservation, 512 limit, retry deletion, duplicate reuse and concurrent edits')

finally:
    quoted_ids = ','.join("'" + value + "'" for value in ids)
    sql(f"DELETE FROM media.processing_jobs WHERE id='{job}'; DELETE FROM catalog.wd14_results WHERE blob_id='{blob}'; DELETE FROM catalog.wd14_character_results WHERE blob_id='{blob}'; DELETE FROM catalog.asset_originals WHERE asset_id IN ({quoted_ids}); DELETE FROM catalog.grants WHERE asset_id IN ({quoted_ids}); DELETE FROM catalog.assets WHERE id IN ({quoted_ids});")
