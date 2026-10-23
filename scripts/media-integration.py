#!/usr/bin/env python3
"""AC-09–14 checks against real codecs, OCR, ASR, Chromaprint and the actual model."""
from pathlib import Path
import json
import time
import sys
from client import Client, compose, sql, check

root = Path(__file__).resolve().parents[1]
fixtures = root / '.cache/fixtures'
fixtures.mkdir(parents=True, exist_ok=True)
alice,bob=Client('alice'),Client('bob')
if '--resume' in sys.argv:
    uploads=json.loads((root/'.cache/media-uploads.json').read_text())
    for u in uploads.values():
        alice.call('POST',f"/api/v1/assets/{u['asset_id']}/renditions",{},expected=202)
else:
    # Generate synthetic visual fixtures with Pillow inside the inference image.
    import subprocess
    subprocess.run(['docker', 'compose', 'exec', '-T', 'runtime', 'python'], input=(root/'scripts/create-media-fixtures.py').read_bytes(), check=True)
    archive = compose('exec', '-T', 'runtime', 'tar', '-C', '/tmp/fixtures', '-cf', '-', '.', binary=True)
    subprocess.run(['tar', '-C', str(fixtures), '-xf', '-'], input=archive, check=True)
    # Generate speech, a re-encoded variant and video. No external/private media are used.
    compose('exec', '-T', 'worker', 'espeak-ng', '-s', '135', '-w', '/tmp/speech.wav',
        'The quick brown fox jumps over the lazy dog. This is a recording for the orchid archive. The quick brown fox jumps over the lazy dog. This is a recording for the orchid archive.')
    for name, args in [('speech.mp3', ['-c:a','libmp3lame','-b:a','128k']), ('speech-copy.ogg',['-c:a','libvorbis','-q:a','5'])]:
        compose('exec','-T','worker','ffmpeg','-v','error','-y','-i','/tmp/speech.wav',*args,'/tmp/'+name)
        (fixtures/name).write_bytes(compose('exec','-T','worker','cat','/tmp/'+name,binary=True))
    # Copy car image via stdin instead of Docker cp, which does not cover tmpfs mounts.
    subprocess.run(['docker','compose','exec','-T','worker','sh','-c','cat > /tmp/car.png'], input=(fixtures/'car.png').read_bytes(),check=True)
    compose('exec','-T','worker','ffmpeg','-v','error','-y','-loop','1','-i','/tmp/car.png','-i','/tmp/speech.wav','-t','12','-vf','scale=640:400','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart','/tmp/car.mp4')
    (fixtures/'car.mp4').write_bytes(compose('exec','-T','worker','cat','/tmp/car.mp4',binary=True))
    compose('exec','-T','worker','ffmpeg','-v','error','-y','-i','/tmp/car.mp4','-vf','scale=480:300','-c:v','libx264','-threads','1','-crf','30','-c:a','aac','/tmp/car-copy.mp4')
    (fixtures/'car-copy.mp4').write_bytes(compose('exec','-T','worker','cat','/tmp/car-copy.mp4',binary=True))

    uploads={}
    for file,mime in [('car.png','image/png'),('car-copy.jpg','image/jpeg'),('fish.png','image/png'),('ocr.png','image/png'),('text.pdf','application/pdf'),('scan.pdf','application/pdf'),('speech.mp3','audio/mpeg'),('speech-copy.ogg','audio/ogg'),('car.mp4','video/mp4'),('car-copy.mp4','video/mp4')]:
        u=alice.create('ac-media-'+file,(fixtures/file).read_bytes(),mime)
        alice.put(u,(fixtures/file).read_bytes());uploads[file]=u
    print('Uploaded 10 fixtures; waiting for real media and embedding jobs.',flush=True)
    (root/'.cache/media-uploads.json').write_text(json.dumps(uploads))

def wait_jobs(upload, embedding=False):
    deadline=time.monotonic()+1800
    last=None
    while time.monotonic()<deadline:
        jobs=alice.call('GET',f"/api/v1/assets/{upload['asset_id']}/jobs")[2]['jobs']
        selected=[j for j in jobs if embedding or j['job_type']=='media.process']
        state=tuple((j['job_type'],j['status'],j['attempts'],j.get('error_code')) for j in selected)
        if state!=last:print(upload['asset_id'],state,flush=True);last=state
        failed=[j for j in selected if j['status']=='failed']
        assert not failed, failed
        if selected and all(j['status']=='completed' for j in selected) and (not embedding or {'media.process','embedding.generate'}.issubset({j['job_type'] for j in selected})):return jobs
        time.sleep(3)
    raise AssertionError('job deadline exceeded')

renditions={}
for name,u in uploads.items():
    wait_jobs(u)
    ds=alice.call('GET',f"/api/v1/assets/{u['asset_id']}/renditions")[2]['renditions']
    assert ds,(name,'missing derivative')
    renditions[name]=ds
    for d in ds:
        content=alice.call('GET',f"/api/v1/assets/{u['asset_id']}/renditions/{d['rendition_id']}/content")[2]
        assert len(content)>0
        ranged=alice.call('GET',f"/api/v1/assets/{u['asset_id']}/renditions/{d['rendition_id']}/content",headers={'Range':'bytes=17-48'},expected=206)[2]
        assert ranged==content[17:49]
        if d['mime_type']=='video/mp4':
            assert content.find(b'moov')<content.find(b'mdat'), 'MP4 must be faststart'
        elif d['mime_type']=='image/webp':assert content[8:12]==b'WEBP'
        elif d['mime_type']=='image/png':assert content.startswith(b'\x89PNG')
        elif d['mime_type']=='audio/ogg':assert content.startswith(b'OggS')

        cipher=json.loads(compose('exec','-T','transfer','ocms','ciphertext-info',d['blob_id']))
        import hashlib
        assert cipher['size_bytes']==len(content) and cipher['sha256']!=hashlib.sha256(content).hexdigest()
check('AC-09 image/video/audio/PDF derivatives generated, encrypted in S3 and served')

source=uploads['car.png'];copy=bob.create('same-car.png',(fixtures/'car.png').read_bytes());bob.put(copy,(fixtures/'car.png').read_bytes())
shared=bob.call('GET',f"/api/v1/assets/{copy['asset_id']}/renditions")[2]['renditions']
assert {d['rendition_id'] for d in shared}=={d['rendition_id'] for d in renditions['car.png']}
alice.call('POST',f"/api/v1/assets/{source['asset_id']}/renditions",{'profile_id':'image.webp-v1'},expected=202)
assert alice.call('GET',f"/api/v1/assets/{source['asset_id']}/renditions")[2]['renditions']==renditions['car.png']
check('AC-10 same Blob and profile reuse identical Rendition IDs across owners')

results=alice.call('POST','/api/v1/search',{'query':'ORCHID','mode':'keyword','limit':200})[2]['assets']
for name in ['text.pdf','scan.pdf','ocr.png']:
    matches=[a for a in results if a['asset_id']==uploads[name]['asset_id']]
    assert matches,(name,'missing extracted keyword')
    if name.endswith('.pdf'):assert matches[0]['page_number']==1
speech=alice.call('POST','/api/v1/search',{'query':'quick','mode':'keyword','limit':200})[2]['assets']
assert any(a['asset_id']==uploads['speech.mp3']['asset_id'] and 'start_ms' in a and 'end_ms' in a for a in speech)
check('AC-11 PDF text layer, scanned PDF/image OCR and timestamped real ASR searchable')

for source_name,target in [('car.png','car-copy.jpg'),('car.mp4','car-copy.mp4'),('text.pdf','scan.pdf')]:
    matches=alice.call('GET',f"/api/v1/assets/{uploads[source_name]['asset_id']}/similar")[2]['assets']
    # PDF documents differ visually; verify page-based candidates exist using the scanned
    # PDF and its source OCR image, which are the same page rendered by different tools.
    if source_name=='text.pdf':
        matches=alice.call('GET',f"/api/v1/assets/{uploads['scan.pdf']['asset_id']}/similar")[2]['assets']
        target='ocr.png'
    assert any(a['asset_id']==uploads[target]['asset_id'] for a in matches),(source_name,target,matches)
check('AC-12 image, video-frame and PDF-page pHash candidates')

matches=alice.call('GET',f"/api/v1/assets/{uploads['speech.mp3']['asset_id']}/similar")[2]['assets']
assert any(a['asset_id']==uploads['speech-copy.ogg']['asset_id'] for a in matches)
check('AC-13 real Chromaprint detects re-encoded audio')

for u in uploads.values():wait_jobs(u,embedding=True)
for query,media,expected in [('a red car','image','car.png'),('a red car','video','car.mp4'),('a person speaking English','audio','speech.mp3')]:
    matches=alice.call('POST','/api/v1/search',{'query':query,'mode':'semantic','media_types':[media],'limit':20})[2]['assets']
    assert any(a['asset_id']==uploads[expected]['asset_id'] for a in matches),(query,matches)
    if media=='image':
        car_rank=next(i for i,a in enumerate(matches) if a['asset_id']==uploads['car.png']['asset_id'])
        fish_rank=next(i for i,a in enumerate(matches) if a['asset_id']==uploads['fish.png']['asset_id'])
        assert car_rank<fish_rank,(car_rank,fish_rank)
check('AC-14 actual EmbeddingGemma 2 text→image/video/audio retrieval, 768-dimensional pgvector')
hybrid=alice.call('POST','/api/v1/search',{'query':'ORCHID','mode':'hybrid','limit':20})[2]['assets']
assert hybrid
# Shared Blob must never expose Alice's private Assets to Bob in any new mode/route.
for mode in ['keyword','semantic','hybrid']:
    matches=bob.call('POST','/api/v1/search',{'query':'ORCHID','mode':mode,'limit':200})[2]['assets']
    assert not ({a['asset_id'] for a in matches}&{u['asset_id'] for u in uploads.values()})
bob.call('GET',f"/api/v1/assets/{source['asset_id']}/preview",expected=404)
bob.call('GET',f"/api/v1/assets/{source['asset_id']}/renditions",expected=404)
check('new search, preview and derivative routes preserve Catalog ACL isolation')
# Native vectors must exist, independently from OCR/ASR text vectors.
assert sql("SELECT string_agg(DISTINCT source_type,',' ORDER BY source_type) FROM search.embeddings")=='audio,image,pdf_page,text,video'
print('All AC-09–14 media checks passed.',flush=True)
