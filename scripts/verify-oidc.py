#!/usr/bin/env python3
"""Run real Hydra flow; retain sensitive scan inputs only in ignored, private files."""
import json
import os
from pathlib import Path
import subprocess

root=Path(__file__).resolve().parents[1]
result=subprocess.run(['docker','compose','-f','compose.yaml','-f','compose.verify.yaml',
    'exec','-T','oidc-login','python','/fixture/oidc_test.py'],cwd=root,capture_output=True,text=True)
if result.returncode:
    print(result.stderr)
    raise SystemExit(result.returncode)
data=json.loads(result.stdout)
fd=os.open(root/'.cache/oidc-sensitive.json',os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'w') as f:json.dump(data['sensitive'],f)
(root/'.cache/oidc-results.json').write_text(json.dumps({'checks':data['checks']},indent=2)+'\n')
for check in data['checks']:print('PASS',check)
