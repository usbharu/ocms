#!/usr/bin/env python3
"""Test golang-migrate against a disposable PostgreSQL container, never the dev DB."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import time
import uuid

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--image', default='ocms-migration-test:local')
parser.add_argument('--postgres-image', default='ocms-postgres:local')
args = parser.parse_args()
name = 'ocms-migrate-test-' + uuid.uuid4().hex[:12]
network = name + '-network'
volume = name + '-data'
password = secrets.token_hex(24)
app_password = secrets.token_hex(24) + "'quoted"


def docker(*cmd, input=None, expected=0):
    result = subprocess.run(['docker', *cmd], input=input, text=True, capture_output=True)
    if expected is not None:
        assert result.returncode == expected, 'Docker operation failed: ' + cmd[0]
    return result


def sql(query):
    return docker('exec', '-i', name, 'psql', '-X', '-qAt', '-U', 'ocms', '-d', 'ocms',
                  '-v', 'ON_ERROR_STOP=1', input=query).stdout.strip()


def check(label):
    print('PASS ' + label, flush=True)


(root / '.cache').mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix='migration-', dir=root / '.cache') as temp:
    temp = Path(temp)
    envfile = temp / 'test.env'
    envfile.write_text('POSTGRES_USER=ocms\nPOSTGRES_DB=ocms\nPOSTGRES_PASSWORD=' + password + '\nDATABASE_URL=postgres://ocms:' + password + '@postgres:5432/ocms?sslmode=disable\nAPP_DB_PASSWORD=' + app_password + '\nMIGRATIONS_DIR=/test-migrations\n')
    with envfile.open('a') as stream:
        stream.write('S3_ACCESS_KEY=test-only\nS3_SECRET_KEY=test-only\nINTERNAL_TOKEN=' + secrets.token_hex(24) + '\n')
    envfile.chmod(0o600)
    migrations = temp / 'migrations'
    shutil.copytree(root / 'migrations', migrations)
    # Containers run as an unprivileged user, while the parent directory stays private.
    migrations.chmod(0o755)
    for file in migrations.iterdir():
        file.chmod(0o644)
    latest = max(int(p.name.split('_')[0]) for p in migrations.glob('*.up.sql'))

    def run(*command, expected=0):
        result = docker('run', '--rm', '--network', network, '--env-file', str(envfile),
                        '-v', str(migrations) + ':/test-migrations:ro', args.image,
                        'migrate', *command, expected=None)
        assert password not in result.stdout + result.stderr
        assert app_password not in result.stdout + result.stderr
        if expected == 0:
            assert result.returncode == 0, 'migration unexpectedly failed: ' + result.stderr[-120:]
        else:
            assert result.returncode != 0, 'migration unexpectedly succeeded'
        return result

    def reset():
        sql('DROP SCHEMA IF EXISTS catalog,storage,media,search CASCADE; DROP TABLE IF EXISTS public.schema_migrations; DROP ROLE IF EXISTS catalog_app,transfer_app,media_app,search_app;')

    try:
        docker('network', 'create', network)
        docker('volume', 'create', volume)
        docker('run', '-d', '--name', name, '--network', network, '--network-alias', 'postgres',
               '--env-file', str(envfile), '-v', volume + ':/var/lib/postgresql/data', args.postgres_image)
        for _ in range(60):
            if docker('exec', name, 'pg_isready', '-U', 'ocms', '-d', 'ocms', expected=None).returncode == 0:
                break
            time.sleep(1)
        else:
            raise AssertionError('test PostgreSQL did not become ready')
        run('up')
        assert sql('SELECT version::text||\':\'||dirty::text FROM public.schema_migrations') == str(latest) + ':false'
        assert sql("SELECT has_table_privilege('catalog_app','catalog.assets','SELECT') AND NOT has_table_privilege('transfer_app','catalog.assets','SELECT')") == 't'
        # Password substitution remains correct even with a quote in the password.
        docker('run', '--rm', '--network', network, '--env-file', str(envfile),
               '-e', 'PGHOST=postgres', '-e', 'PGUSER=catalog_app', '-e', 'PGDATABASE=ocms',
               '-e', 'PGPASSWORD=' + app_password, '--entrypoint', 'psql', args.postgres_image,
               '-XqAt', '-c', 'SELECT count(*) FROM catalog.assets')
        # Check with pg_authid too, without returning hashes or passwords.
        assert sql("SELECT count(*) FROM pg_authid WHERE rolname IN ('catalog_app','transfer_app','media_app','search_app') AND rolpassword IS NOT NULL") == '4'
        sql("INSERT INTO media.processing_jobs(event_id,source_blob_id,job_type,status) VALUES(gen_random_uuid(),gen_random_uuid(),'tags.generate','completed')")
        run('up')
        assert sql("SELECT status FROM media.processing_jobs LIMIT 1") == 'completed'
        run('version')
        check('empty database, version, repeat execution and role separation')

        # An application data sentinel catches accidental reinitialization.
        sql("INSERT INTO catalog.principals(oidc_issuer,oidc_subject) VALUES('migration-test','sentinel')")
        reset()
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda _: run('up'), range(4)))
        assert sql('SELECT count(*) FROM public.schema_migrations') == '1'
        check('four concurrent up processes use the upstream PostgreSQL lock')

        # Simulate a real pre-tool database: existing schemas, but no version table.
        sql('DROP TABLE public.schema_migrations;')
        sql("INSERT INTO catalog.principals(oidc_issuer,oidc_subject) VALUES('migration-test','sentinel')")
        result = run('up', expected=1)
        assert 'MIGRATION_BASELINE_REQUIRED' in result.stderr
        run('baseline', str(latest))
        run('baseline', str(latest), expected=1)
        run('up')
        assert sql("SELECT count(*) FROM catalog.principals WHERE oidc_subject='sentinel'") == '1'
        check('legacy database requires explicit baseline and retains data')

        # Adoption must also work when later schema/data migrations are pending.
        for baseline in (2, 4):
            reset()
            stash = temp / f'stash-{baseline}'
            stash.mkdir()
            for migration in list(migrations.glob('*.up.sql')):
                if int(migration.name.split('_')[0]) > baseline:
                    shutil.move(str(migration), stash / migration.name)
            run('up')
            sql('DROP TABLE public.schema_migrations;')
            sql("INSERT INTO catalog.principals(oidc_issuer,oidc_subject) VALUES('migration-test','sentinel')")
            if baseline == 4:
                sql("INSERT INTO media.processing_jobs(event_id,source_blob_id,job_type,status) VALUES(gen_random_uuid(),gen_random_uuid(),'media.process','completed'); INSERT INTO media.blob_metadata(blob_id,mime_type) SELECT source_blob_id,'image/png' FROM media.processing_jobs;")
            for migration in stash.iterdir():
                shutil.move(str(migration), migrations / migration.name)
            run('baseline', str(baseline))
            run('up')
            assert sql('SELECT version FROM public.schema_migrations') == str(latest)
            assert sql("SELECT count(*) FROM catalog.principals WHERE oidc_subject='sentinel'") == '1'
            if baseline == 4:
                assert sql("SELECT count(*) FROM media.processing_jobs WHERE job_type='tags.generate'") == '1'
        check('002 and 004 legacy databases apply pending role/schema/backfill changes once')

        # Later SQL files apply automatically; a failed transaction leaves dirty state.
        probe = migrations / f'{latest + 1:03d}_probe.up.sql'
        probe.write_text('BEGIN; CREATE TABLE catalog.migration_probe(id integer); SELECT 1/0; COMMIT;\n')
        probe.chmod(0o644)
        result = run('up', expected=1)
        assert 'MIGRATION_SQL_FAILED' in result.stderr
        assert sql("SELECT to_regclass('catalog.migration_probe') IS NULL") == 't'
        assert sql('SELECT dirty FROM public.schema_migrations') == 't'
        assert 'MIGRATION_DIRTY' in run('up', expected=1).stderr
        probe.write_text('BEGIN; CREATE TABLE catalog.migration_probe(id integer); COMMIT;\n')
        run('force', str(latest))
        run('up')
        assert sql('SELECT version FROM public.schema_migrations') == str(latest + 1)
        assert sql("SELECT count(*) FROM catalog.principals WHERE oidc_subject='sentinel'") == '1'
        check('pending SQL, rollback, dirty-state blocking, explicit force and retry')
        probe.unlink()
        assert 'MIGRATION_DATABASE_NEWER_THAN_IMAGE' in run('up', expected=1).stderr
        check('older image refuses a newer database')

        # A file copied under the former name must fail rather than be ignored.
        old = migrations / f'{latest + 2:03d}_legacy_name.sql'
        old.write_text('SELECT 1;\n')
        old.chmod(0o644)
        assert 'MIGRATION_FILENAME_INVALID' in run('up', expected=1).stderr
        old.unlink()
        check('unnormalized SQL filename is rejected')

        # Database-side error CONTEXT must not reveal expanded role passwords.
        reset()
        sql("ALTER SYSTEM SET log_statement='all';")
        sql('SELECT pg_reload_conf();')
        sql('CREATE ROLE catalog_app LOGIN;')
        result = run('up', expected=1)
        assert 'MIGRATION_SQL_FAILED' in result.stderr
        logs = docker('logs', name).stdout + docker('logs', name).stderr
        assert password not in logs and app_password not in logs, 'credentials leaked in test PostgreSQL logs'
        check('driver errors and verbose PostgreSQL logs omit generated credentials')
        sql('DROP ROLE catalog_app;')
        run('force', '-1')
        run('up')
        assert sql('SELECT version FROM public.schema_migrations') == str(latest)
        check('first-migration rollback recovers with the upstream nil version (-1)')

        # Use the real Compose dependency graph on a separate empty database.
        # No port mappings or existing development containers are involved.
        config = json.loads(docker('compose', '--env-file', str(envfile), '-f', str(root / 'compose.yaml'), 'config', '--format', 'json').stdout)
        services = {key: config['services'][key] for key in ('postgres', 'migrate', 'catalog')}
        for key, service in services.items():
            service.pop('build', None)
            service['image'] = args.postgres_image if key == 'postgres' else args.image
        services['migrate']['volumes'] = [{'type': 'bind', 'source': str(migrations), 'target': '/app/migrations', 'read_only': True}]
        gatefile = temp / 'gate.json'
        gatefile.write_text(json.dumps({'services': services, 'volumes': {'postgres': {}}, 'networks': {'default': {}}}))
        gatefile.chmod(0o600)
        gateproject = name + '-gate'
        prefix = ('compose', '-p', gateproject, '-f', str(gatefile))
        try:
            probe.write_text('BEGIN; CREATE TABLE catalog.migration_probe(id integer); SELECT 1/0; COMMIT;\n')
            probe.chmod(0o644)
            assert docker(*prefix, 'up', '-d', '--wait', 'catalog', expected=None).returncode != 0
            catalog_id = docker(*prefix, 'ps', '-aq', 'catalog').stdout.strip()
            state = docker('inspect', catalog_id, '--format', '{{.State.Status}}').stdout.strip()
            assert state == 'created', 'application started despite failed migration'
            probe.write_text('BEGIN; CREATE TABLE catalog.migration_probe(id integer); COMMIT;\n')
            docker(*prefix, 'run', '--rm', 'migrate', 'migrate', 'force', str(latest))
            docker(*prefix, 'up', '-d', '--wait', 'catalog')
            state = docker('inspect', catalog_id, '--format', '{{.State.Health.Status}}').stdout.strip()
            assert state == 'healthy'
            # A completed one-shot container must run again on the next up.
            next_probe = migrations / f'{latest + 2:03d}_next_probe.up.sql'
            next_probe.write_text('BEGIN; CREATE TABLE catalog.migration_next_probe(id integer); COMMIT;\n')
            next_probe.chmod(0o644)
            docker(*prefix, 'stop', 'catalog')
            docker(*prefix, 'up', '-d', '--wait', 'catalog')
            postgres_id = docker(*prefix, 'ps', '-q', 'postgres').stdout.strip()
            version = docker('exec', postgres_id, 'psql', '-XqAt', '-U', 'ocms', '-d', 'ocms', '-c', 'SELECT version FROM public.schema_migrations').stdout.strip()
            assert version == str(latest + 2)
            next_probe.unlink()
            check('Compose blocks application startup on failure and reruns migrations on update')
        finally:
            docker(*prefix, 'down', '--volumes', expected=None)
    finally:
        docker('rm', '-f', name, expected=None)
        docker('volume', 'rm', volume, expected=None)
        docker('network', 'rm', network, expected=None)
