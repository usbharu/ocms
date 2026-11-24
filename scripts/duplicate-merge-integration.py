#!/usr/bin/env python3
"""Verify permanent same-owner duplicate merging on the development stack.

The checks cover the upload path and the migration 016 merge function. Synthetic
rows are removed; uploaded Assets are left logically deleted like other tests.
"""
import uuid
from client import Client, sql, check

alice, bob = Client('alice'), Client('bob')
alice_id = alice.me['principal_id']
bob_id = bob.me['principal_id']
prefix = 'merge-' + uuid.uuid4().hex
seed_prefix = prefix + '-legacy'
body = b'\x89PNG\r\n\x1a\n' + uuid.uuid4().bytes + bytes(range(256)) * 256
seeded = []
first_id = None
other = None

try:
    # The same owner's identical bytes with a different name reuse one Asset.
    first = alice.create(prefix + '-one.png', body)
    alice.put(first, body)
    first_id = first['asset_id']
    second = alice.create(prefix + '-two.png', body)
    merged = alice.put(second, body)[2]
    assert merged['asset_id'] == first_id
    details = alice.asset(first)
    assert details['aliases'] == [prefix + '-two.png']
    assert details['blob_id']
    # Another owner keeps an independent registration of the same Blob.
    other = bob.create(prefix + '-other.png', body)
    bob.put(other, body)
    assert other['asset_id'] != first_id
    assert bob.asset(other)['blob_id'] == details['blob_id']
    alice.call('GET', '/api/v1/assets/' + other['asset_id'], expected=404)
    check('same-owner same-hash uploads merge; another owner stays independent')

    # Seed the pre-migration state, then apply the same merge function used by 016.
    ids = {name: str(uuid.uuid4()) for name in ('old', 'keep', 'series', 'member', 'group', 'session', 'blob')}
    seeded.extend(ids[name] for name in ('old', 'keep', 'series', 'member'))
    old, keep = ids['old'], ids['keep']
    series, member = ids['series'], ids['member']
    group, session, blob = ids['group'], ids['session'], ids['blob']
    sql(f"""INSERT INTO catalog.assets(id,owner_id,filename,mime_type,tags,rating,status,created_at) VALUES
      ('{old}','{alice_id}','{seed_prefix}-old.png','image/png',ARRAY['one'],'general','ready',now()-interval '2 minutes'),
      ('{keep}','{alice_id}','{seed_prefix}-keep.png','image/png',ARRAY['two'],'explicit','ready',now()-interval '1 minute'),
      ('{member}','{alice_id}','{seed_prefix}-member.png','image/png',ARRAY['four'],'general','ready',now()-interval '1 minute'),
      ('{series}','{alice_id}','{seed_prefix}-series','application/vnd.ocms.series','{{}}','unrated','ready',now());
      INSERT INTO catalog.asset_originals(asset_id,blob_id) VALUES
      ('{old}','{blob}'),('{keep}','{blob}'),('{member}',gen_random_uuid());
      INSERT INTO catalog.asset_characters(asset_id,name,position) VALUES
      ('{old}','hero-one',0),('{keep}','hero-two',0);
      INSERT INTO catalog.series(asset_id,kind,version) VALUES('{series}','collection',1);
      INSERT INTO catalog.series_members(series_id,asset_id,position,composite) VALUES
      ('{series}','{old}',0,false),('{series}','{member}',1,false);
      INSERT INTO catalog.asset_favorites(principal_id,asset_id,created_at) VALUES('{alice_id}','{old}',now());
      INSERT INTO catalog.content_groups(id,principal_id,name) VALUES('{group}','{alice_id}','{seed_prefix}-group');
      INSERT INTO catalog.asset_groups(group_id,principal_id,asset_id) VALUES('{group}','{alice_id}','{old}');
      INSERT INTO catalog.default_group_exclusions(principal_id,asset_id) VALUES('{alice_id}','{old}');
      INSERT INTO catalog.grants(asset_id,principal_id,permission) VALUES('{old}','{bob_id}','read');
      INSERT INTO catalog.upload_sessions(id,asset_id,expected_size,state) VALUES('{session}','{old}',1,'completed');""")
    # The retired query-time dedup would have shown one Blob for this owner.
    legacy_total = int(sql(f"SELECT count(DISTINCT o.blob_id) FROM catalog.assets a JOIN catalog.asset_originals o ON o.asset_id=a.id WHERE a.owner_id='{alice_id}' AND a.deleted_at IS NULL AND o.blob_id='{blob}'"))
    sql(f"SELECT catalog.merge_asset('{keep}','{old}')")
    result = alice.call('GET', '/api/v1/assets?q=' + seed_prefix + '-old&limit=200')[2]
    assert result['total'] == legacy_total == 1 and [a['asset_id'] for a in result['assets']] == [keep]
    details = alice.call('GET', '/api/v1/assets/' + keep)[2]
    assert details['tags'] == ['two', 'one']
    assert details['characters'] == ['hero-two', 'hero-one']
    assert details['aliases'] == [seed_prefix + '-old.png']
    assert details['rating'] == 'explicit' and details['is_favorite']
    assert 'default' in alice.call('GET', '/api/v1/assets/' + keep + '/groups')[2]['group_ids']
    assert group in alice.call('GET', '/api/v1/assets/' + keep + '/groups')[2]['group_ids']
    assert alice.call('GET', '/api/v1/assets/' + old, expected=404)
    assert bob.call('GET', '/api/v1/assets/' + keep)[2]['asset_id'] == keep
    assert sql(f"SELECT asset_id::text FROM catalog.upload_sessions WHERE id='{session}'") == keep
    series_detail = alice.call('GET', '/api/v1/series/' + series)[2]
    assert [a['asset_id'] for a in series_detail['members']] == [keep, member]
    # The old filename stays searchable through the alias table.
    found = alice.call('POST', '/api/v1/search', {'mode': 'keyword', 'query': seed_prefix + '-old'})[2]['assets']
    assert [a['asset_id'] for a in found] == [keep]
    check('migration merge preserves visible set, labels, favorites, groups, grants, session and series')
finally:
    quoted = ','.join("'" + i + "'" for i in seeded)
    if quoted:
        sql(f"""BEGIN;
DELETE FROM catalog.asset_favorites WHERE asset_id IN({quoted});
DELETE FROM catalog.asset_groups WHERE asset_id IN({quoted});
DELETE FROM catalog.default_group_exclusions WHERE asset_id IN({quoted});
DELETE FROM catalog.grants WHERE asset_id IN({quoted});
DELETE FROM catalog.upload_sessions WHERE asset_id IN({quoted});
DELETE FROM catalog.series_members WHERE series_id IN({quoted}) OR asset_id IN({quoted});
DELETE FROM catalog.series WHERE asset_id IN({quoted});
DELETE FROM catalog.asset_characters WHERE asset_id IN({quoted});
DELETE FROM catalog.asset_originals WHERE asset_id IN({quoted});
DELETE FROM catalog.assets WHERE id IN({quoted});
DELETE FROM catalog.content_groups WHERE principal_id='{alice_id}' AND name='{seed_prefix}-group';
COMMIT;""")
    if first_id:
        sql(f"UPDATE catalog.assets SET deleted_at=now(),status='deleted' WHERE id IN('{first_id}','{other['asset_id']}')")
print('All duplicate merge integration checks passed.')
