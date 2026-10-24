#!/usr/bin/env python3
"""Real PostgreSQL/Catalog/Search tests using synthetic rows, removed on exit.
Run only against the default local development stack. No private media is used.
"""
import uuid
import subprocess
import json
import sys
from pathlib import Path
from client import Client, check


def sql(query):
    # stdin avoids platform argument-size limits and keeps SQL out of exceptions.
    result = subprocess.run(
        ['docker', 'compose', 'exec', '-T', 'postgres', 'psql', '-v',
         'ON_ERROR_STOP=1', '-U', 'ocms', '-d', 'ocms', '-tA'],
        input=query, text=True, capture_output=True,
    )
    if result.returncode:
        raise RuntimeError('synthetic recommendation fixture SQL failed')
    return result.stdout.strip()


alice, bob = Client('alice'), Client('bob')
owner, other = alice.me['principal_id'], bob.me['principal_id']
ids, blobs = [], []
label = 'recommendation-' + uuid.uuid4().hex


def asset(tags=(), characters=(), owner_id=owner, blob=None, mime='image/png'):
    aid, bid = str(uuid.uuid4()), blob or str(uuid.uuid4())
    ids.append(aid)
    blobs.append(bid)
    # SQL values are generated locally, never taken from media or user input.
    tag_array = 'ARRAY[' + ','.join("'" + t + "'" for t in tags) + ']::text[]'
    sql(f"INSERT INTO catalog.assets(id,owner_id,filename,mime_type,tags,status) VALUES('{aid}','{owner_id}','synthetic-recommendation','{mime}',{tag_array},'ready'); INSERT INTO catalog.asset_originals(asset_id,blob_id) VALUES('{aid}','{bid}')")
    for i, name in enumerate(characters):
        sql(f"INSERT INTO catalog.asset_characters(asset_id,name,position) VALUES('{aid}','{name}',{i})")
    return aid, bid


def hashes(blob, bits, page=1, ordinal=0):
    sql(f"INSERT INTO search.perceptual_hashes(blob_id,kind,ordinal,page_number,phash) VALUES('{blob}','pdf_page',{ordinal},{page},'{bits}'::bit(64))")


def recommendations(aid):
    return alice.call('GET', f'/api/v1/assets/{aid}/recommendations')[2]


try:
    source, source_blob = asset([label], [label])
    tags, _ = asset([label, label])
    partial_tags, _ = asset([label, label + '-extra'])
    chars, _ = asset([], [label])
    mixed, mixed_blob = asset([label], [label])
    duplicate, _ = asset([label], [label], blob=source_blob)
    hidden, hidden_blob = asset([label], [label], owner_id=other)
    deleted, _ = asset([label], [label])
    sql(f"UPDATE catalog.assets SET deleted_at=now(),status='deleted' WHERE id='{deleted}'")
    shared, shared_blob = asset([label])
    shared_other, _ = asset([], blob=shared_blob)
    result = recommendations(source)
    assert result['hash_status'] == 'pending'
    items = {a['asset_id']: a for a in result['assets']}
    assert items[mixed]['score'] == 80 and items[chars]['score'] == 50 and items[tags]['score'] == 30
    assert items[partial_tags]['score'] == 15
    assert not {source, duplicate, hidden, deleted, shared_other} & items.keys()
    bob.call('GET', f'/api/v1/assets/{source}/recommendations', expected=404)
    alice.call('GET', f'/api/v1/assets/{deleted}/recommendations', expected=404)
    check('metadata weights, duplicate labels, pending hashes, ACL, deletion and per-Asset metadata')

    bits = '11001010' * 8
    hashes(source_blob, bits)
    hashes(mixed_blob, bits, page=7)
    hashes(mixed_blob, '00110101' * 8, page=1, ordinal=1)
    hashes(shared_blob, bits)
    hashes(hidden_blob, bits)
    result = recommendations(source)
    items = {a['asset_id']: a for a in result['assets']}
    assert result['hash_status'] == 'ready'
    assert items[mixed]['score'] == 100 and items[mixed]['page_number'] == 7
    assert items[shared]['score'] == 50 and items[shared_other]['score'] == 20
    assert items[shared_other]['common_tags'] == [] and hidden not in items and duplicate not in items
    sql(f"INSERT INTO catalog.grants(asset_id,principal_id,permission) VALUES('{hidden}','{owner}','read')")
    assert hidden in {a['asset_id'] for a in recommendations(source)['assets']}
    sql(f"DELETE FROM catalog.grants WHERE asset_id='{hidden}'")
    assert hidden not in {a['asset_id'] for a in recommendations(source)['assets']}
    check('real pHash SQL, closest page, hash-only candidates, read grant and revocation')

    audio_source, audio_blob = asset(mime='audio/ogg')
    audio_copy, copy_blob = asset(mime='audio/ogg')
    assert recommendations(audio_source)['hash_status'] == 'pending'
    for blob in [audio_blob, copy_blob]:
        sql(f"INSERT INTO search.audio_fingerprints(blob_id,fingerprint) VALUES('{blob}',ARRAY[-12345678,4211398,-98322114,191991,2928292,-191922,3848176,196388])")
    match = next(a for a in recommendations(audio_source)['assets'] if a['asset_id'] == audio_copy)
    assert match['score'] == 20 and match['perceptual'] == 'audio'
    check('real audio fingerprint candidate query')

    many = [str(uuid.uuid4()) for _ in range(1005)]
    ids.extend(many)
    values = ','.join(f"('{aid}','{owner}','synthetic-limit','text/plain',ARRAY['{label}'],'ready')" for aid in many)
    sql('INSERT INTO catalog.assets(id,owner_id,filename,mime_type,tags,status) VALUES ' + values)
    result = recommendations(source)['assets']
    assert len(result) == 200
    for first, second in zip(result, result[1:]):
        assert first['score'] >= second['score']
        if first['score'] == second['score']:
            assert first['asset_id'] < second['asset_id']
    check('candidate pool above 1,000, final 200 cap and deterministic ordering')
finally:
    asset_ids = ','.join("'" + i + "'" for i in ids)
    blob_ids = ','.join("'" + i + "'" for i in set(blobs))
    if asset_ids:
        sql(f"BEGIN; DELETE FROM catalog.grants WHERE asset_id IN ({asset_ids}); DELETE FROM catalog.asset_characters WHERE asset_id IN ({asset_ids}); DELETE FROM catalog.asset_originals WHERE asset_id IN ({asset_ids}); DELETE FROM catalog.assets WHERE id IN ({asset_ids}); COMMIT")
    if blob_ids:
        sql(f"DELETE FROM search.perceptual_hashes WHERE blob_id IN ({blob_ids}); DELETE FROM search.audio_fingerprints WHERE blob_id IN ({blob_ids})")
if '--media' in sys.argv:
    uploads = json.loads((Path(__file__).resolve().parents[1] / '.cache/media-uploads.json').read_text())
    for original, similar in [('car.png', 'car-copy.jpg'), ('speech.mp3', 'speech-copy.ogg')]:
        response = recommendations(uploads[original]['asset_id'])
        assert response['hash_status'] == 'ready'
        match = next(a for a in response['assets'] if a['asset_id'] == uploads[similar]['asset_id'])
        assert match['perceptual'] == ('audio' if original.endswith('.mp3') else 'visual')
    check('recommendations from actual generated image and audio media')
print('All recommendation integration checks passed.')
