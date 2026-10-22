"""Initialize ignored, generated credentials and an OTLP evidence directory."""
from pathlib import Path
import os
import secrets
root=Path(__file__).resolve().parents[1]
env=root/'.env'
if not env.exists():raise SystemExit('Run python3 scripts/dev-init.py first.')
existing=env.read_text()
with env.open('a') as output:
    for key in ['HYDRA_SYSTEM_SECRET','HYDRA_CLIENT_SECRET']:
        if not any(line.startswith(key+'=') for line in existing.splitlines()):
            output.write(key+'='+secrets.token_hex(32)+'\n')
path=root/'.cache/otel'
path.mkdir(parents=True,exist_ok=True)
os.chmod(path,0o777)  # Collector's unprivileged uid writes only generated test evidence.
print('Verification configuration ready; credentials remain in ignored .env.')
