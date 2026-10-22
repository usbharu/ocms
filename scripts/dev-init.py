#!/usr/bin/env python3
"""Generate local-only credentials without overwriting an existing configuration."""
import base64
import os
from pathlib import Path
import secrets

root = Path(__file__).resolve().parents[1]
def create(path, content, mode):
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    except FileExistsError:
        return
    with os.fdopen(fd, 'w') as out:
        out.write(content)

(root / 'secrets').mkdir(mode=0o700, exist_ok=True)
create(root / '.env', '\n'.join(f'{k}={secrets.token_hex(32)}' for k in [
    'POSTGRES_PASSWORD', 'APP_DB_PASSWORD', 'INTERNAL_TOKEN', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'
]) + '\nAUTH_MODE=development\n', 0o600)
# File must be readable by the unprivileged container user; its directory stays 0700.
create(root / 'secrets/crypto.yaml', 'active_key_id: master-v1\nkeys:\n  master-v1: "' + base64.b64encode(secrets.token_bytes(32)).decode() + '"\n', 0o644)
print('Local configuration ready (.env and secrets/ are ignored by Git).')
