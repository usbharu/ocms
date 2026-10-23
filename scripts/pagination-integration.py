#!/usr/bin/env python3
"""Verify list pagination against the development stack with synthetic DB rows."""
import uuid
from client import Client, sql, check

alice, bob = Client('alice'), Client('bob')
aid = str(uuid.UUID(alice.me['principal_id']))
bid = str(uuid.UUID(bob.me['principal_id']))
prefix = 'pagination-' + uuid.uuid4().hex
shared, hidden = str(uuid.uuid4()), str(uuid.uuid4())
try:
    # One timestamp deliberately exercises the ID tie-breaker across page boundaries.
    sql(f"""INSERT INTO catalog.assets(owner_id,filename,mime_type)
        SELECT '{aid}', '{prefix}-' || i,
            CASE WHEN i % 2 = 0 THEN 'image/png' ELSE 'application/pdf' END
        FROM generate_series(0,216) i;
        INSERT INTO catalog.assets(id,owner_id,filename,mime_type) VALUES
        ('{shared}','{bid}','{prefix}-shared','image/png'),
        ('{hidden}','{bid}','{prefix}-hidden','image/png');
        INSERT INTO catalog.grants(asset_id,principal_id,permission)
        VALUES ('{shared}','{aid}','read');
        UPDATE catalog.assets SET deleted_at=now(),status='deleted'
        WHERE filename='{prefix}-216' AND owner_id='{aid}';""")
    base = f'/api/v1/assets?q={prefix}'
    default = alice.call('GET', base)[2]
    assert len(default['assets']) == 200 and default['total'] == 217
    ids = []
    for offset in range(0, 217, 24):
        path = f'{base}&limit=24&offset={offset}'
        result = alice.call('GET', path)[2]
        assert result['total'] == 217
        assert len(result['assets']) == min(24, 217 - offset)
        assert alice.call('GET', path)[2] == result
        ids.extend(item['asset_id'] for item in result['assets'])
    assert len(set(ids)) == 217 and shared in ids and hidden not in ids
    assert alice.call('GET', f'{base}&limit=24&offset=217')[2]['assets'] == []
    for kind, count in [('image', 109), ('document', 108), ('audio', 0), ('video', 0)]:
        result = alice.call('GET', f'{base}&kind={kind}&limit=24')[2]
        assert result['total'] == count and len(result['assets']) == min(24, count)
    assert bob.call('GET', base)[2]['total'] == 2
    for invalid in ['limit=0', 'limit=201', 'offset=-1', 'offset=x', 'kind=unknown']:
        alice.call('GET', f'{base}&{invalid}', expected=400)
    check('pagination beyond 200, stable ordering, MIME filters, ACL totals and invalid parameters')
finally:
    # Delete only this run's synthetic rows; no uploads, media or S3 objects are created.
    sql(f"""DELETE FROM catalog.grants WHERE asset_id='{shared}';
        DELETE FROM catalog.assets WHERE filename LIKE '{prefix}%'
        AND owner_id IN ('{aid}','{bid}');""")
