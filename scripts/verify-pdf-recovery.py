#!/usr/bin/env python3
"""Verify recovered real PDFs without printing document text, filenames or credentials."""
import json
from pathlib import Path
import subprocess
import sys
import time
import uuid
from client import sql, check

blobs=[str(uuid.UUID(value)) for value in sys.argv[1:]]
assert blobs, 'Usage: python3 scripts/verify-pdf-recovery.py <blob-id> [<blob-id> ...]'
ids=','.join("'"+value+"'" for value in blobs)
query=f"""SELECT coalesce(json_agg(t),'[]') FROM (
 SELECT j.source_blob_id AS blob_id,j.job_type,j.status,j.error_code,j.attempts
 FROM media.processing_jobs j WHERE j.source_blob_id IN ({ids}) ORDER BY j.source_blob_id,j.job_type
) t"""
deadline=time.monotonic()+3600
previous=None
while time.monotonic()<deadline:
    jobs=json.loads(sql(query))
    assert len(jobs)==len(blobs)*2, 'expected both processing and embedding jobs'
    assert not any(j['status']=='failed' for j in jobs), jobs
    state=[(j['blob_id'],j['job_type'],j['status']) for j in jobs]
    if state!=previous:print(json.dumps(state),flush=True);previous=state
    if all(j['status']=='completed' for j in jobs):break
    time.sleep(5)
else:raise AssertionError('PDF recovery timed out')

probe=r'''
import json,os,re,sys,urllib.request as r,urllib.parse as u
spec=json.load(sys.stdin)
headers={'X-Service-Token':os.environ['INTERNAL_TOKEN'],'X-Principal':spec['principal_id']}
def call(base,path,data=None,extra=None):
 h={**headers,**(extra or {})}
 if data is not None:h['Content-Type']='application/json'
 req=r.Request('http://'+base+':8080'+path,json.dumps(data).encode() if data is not None else None,headers=h)
 with r.urlopen(req,timeout=180) as response:return response.status,response.read()
path='/api/v1/assets/'+spec['asset_id']+'/preview?page='+str(spec['pages'])
status,image=call('transfer',path)
assert status==200 and image.startswith(bytes.fromhex('89504e470d0a1a0a'))
status,part=call('transfer',path,extra={'Range':'bytes=17-48'})
assert status==206 and part==image[17:49]
keyword=spec.get('keyword')
# The query arrives privately on stdin and never enters test output.
if keyword:
 _,raw=call('search','/api/v1/search',{'query':keyword[:100],'mode':'keyword','limit':200})
 assert any(a['asset_id']==spec['asset_id'] for a in json.loads(raw)['assets'])
_,raw=call('search','/api/v1/search',{'query':'document','mode':'semantic','limit':200})
assert any(a['asset_id']==spec['asset_id'] for a in json.loads(raw)['assets'])
print(json.dumps({'last_page_bytes':len(image),'keyword_checked':bool(keyword),'semantic_checked':True}))
'''
results=[]
for blob in blobs:
    detail=json.loads(sql(f"""SELECT json_build_object(
      'blob_id',m.blob_id,'pages',(m.metadata->>'pages')::int,
      'asset_id',a.id,'principal_id',a.owner_id,'status',a.status,
      'previews',(SELECT count(DISTINCT profile_id) FROM media.renditions WHERE source_blob_id=m.blob_id AND profile_id LIKE 'pdf.page-%'),
      'native_pages',(SELECT count(DISTINCT page_number) FROM search.embeddings WHERE blob_id=m.blob_id AND source_type='pdf_page'),
      'passages',(SELECT count(*) FROM search.passages WHERE blob_id=m.blob_id),
      'keyword',(SELECT substring(content from '[[:alpha:]]{{4,}}') FROM search.passages WHERE blob_id=m.blob_id AND content ~ '[[:alpha:]]{{4,}}' ORDER BY ordinal LIMIT 1),
      'vectors',(SELECT count(*) FROM search.embeddings WHERE blob_id=m.blob_id),
      'checkpoints',(SELECT count(*) FROM media.embedding_checkpoints c JOIN media.processing_jobs j ON j.id=c.job_id WHERE j.source_blob_id=m.blob_id))
      FROM media.blob_metadata m JOIN catalog.asset_originals o ON o.blob_id=m.blob_id JOIN catalog.assets a ON a.id=o.asset_id
      WHERE m.blob_id='{blob}' AND a.deleted_at IS NULL ORDER BY a.created_at LIMIT 1"""))
    assert detail['status']=='ready', 'Catalog status not ready'
    assert detail['pages']==detail['previews']==detail['native_pages'], 'incomplete page coverage'
    assert detail['checkpoints']==0, 'completed checkpoints not cleaned up'
    output=subprocess.run(['docker','compose','exec','-T','runtime','python','-c',probe],input=json.dumps(detail),capture_output=True,text=True)
    assert output.returncode==0, 'Preview/Range/search verification failed: '+output.stderr
    public={k:detail[k] for k in ['blob_id','pages','status','previews','native_pages','passages','vectors','checkpoints']}
    public.update(json.loads(output.stdout));results.append(public)
    check(f"{detail['pages']}-page PDF: all previews/native pages, completed jobs, ready state, last-page Range and search")
Path('.cache/pdf-recovery-results.json').write_text(json.dumps(results,indent=2)+'\n')
