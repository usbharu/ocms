#!/usr/bin/env python3
"""Exercise series HTTP APIs against disposable PostgreSQL, never the dev DB.
Requires Docker, Go 1.26+ and the ocms-postgres:local image.
"""
import os
from pathlib import Path
import subprocess
import time
import uuid

root = Path(__file__).resolve().parents[1]
name = 'ocms-series-test-' + uuid.uuid4().hex[:12]


def docker(*args, input=None):
    result = subprocess.run(['docker', *args], input=input, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError('Disposable series database operation failed: ' + args[0])
    return result.stdout.strip()


try:
    docker('run', '-d', '--name', name, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
           '-e', 'POSTGRES_USER=ocms', '-e', 'POSTGRES_DB=ocms',
           '-p', '127.0.0.1::5432', 'ocms-postgres:local')
    for _ in range(60):
        result = subprocess.run(['docker', 'exec', name, 'pg_isready', '-h', '127.0.0.1',
                                 '-U', 'ocms'], capture_output=True)
        if result.returncode == 0:
            break
        time.sleep(1)
    else:
        raise RuntimeError('Disposable series database did not become ready')
    # Synthetic credentials are scoped to this disposable database.
    sql = "SELECT set_config('ocms.app_db_password','series-test-only',false);\n"
    sql += '\n'.join(p.read_text() for p in sorted((root / 'migrations').glob('*.up.sql')))
    docker('exec', '-i', name, 'psql', '-U', 'ocms', '-v', 'ON_ERROR_STOP=1', input=sql)
    port = docker('port', name, '5432/tcp').rsplit(':', 1)[1]
    env = dict(os.environ)
    env['OCMS_TEST_DATABASE_URL'] = f'postgres://ocms@127.0.0.1:{port}/ocms?sslmode=disable'
    for key, path in [('GOPATH', 'go'), ('GOMODCACHE', 'go-mod'), ('GOCACHE', 'go-build')]:
        env.setdefault(key, str(root / '.cache' / path))
    subprocess.run(['go', 'test', '-race', './internal/catalog', './internal/search',
                    '-run', 'Test(SeriesDatabase|ContentRatingsDatabase|PersonalRecommendationsDatabase|KeywordSearchWithSemanticSearchDisabledDatabase)$'],
                   cwd=root, env=env, check=True)
    print('PASS series and existing catalog/search database regressions')
finally:
    subprocess.run(['docker', 'rm', '-f', '-v', name], capture_output=True)
