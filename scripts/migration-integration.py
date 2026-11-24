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
    # Hold the socket-only initialization server open to reproduce fast Linux CI.
    init_gate = temp / 'init-gate'
    init_gate.mkdir()
    init_gate.chmod(0o777)
    init_script = temp / 'wait-for-test.sh'
    init_script.write_text('touch /test-init/ready\nwhile [ ! -f /test-init/release ]; do sleep 0.1; done\n')
    init_script.chmod(0o644)

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
               '--env-file', str(envfile), '-v', volume + ':/var/lib/postgresql/data',
               '-v', str(init_gate) + ':/test-init',
               '-v', str(init_script) + ':/docker-entrypoint-initdb.d/000-test-wait.sh:ro', args.postgres_image)
        for _ in range(60):
            if (init_gate / 'ready').exists():
                break
            time.sleep(1)
        else:
            raise AssertionError('test initialization hook did not become ready')
        assert docker('exec', name, 'pg_isready', '-U', 'ocms', '-d', 'ocms', expected=None).returncode == 0
        assert docker('exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'ocms', '-d', 'ocms', expected=None).returncode != 0
        assert 'MIGRATION_DATABASE_UNAVAILABLE' in run('up', expected=1).stderr
        (init_gate / 'release').touch()
        check('socket-only initialization is not TCP-ready for migrations')
        for _ in range(60):
            if docker('exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'ocms', '-d', 'ocms', expected=None).returncode == 0:
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

        # Migration 015 merges same-owner duplicates without changing the set of
        # content visible to a principal. Seed first, then apply only 015.
        reset()
        merge = migrations / '015_merge_duplicate_assets.up.sql'
        stash015 = temp / '015-stash'
        stash015.mkdir()
        shutil.move(str(merge), stash015 / merge.name)
        run('up')
        p1, p2 = ('11111111-1111-4111-8111-111111111111',
                  '22222222-2222-4222-8222-222222222222')
        a1, a2, a3, a4 = ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
                          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
                          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
                          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4')
        s1, b1, b2, g1 = ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
                          'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
                          'cccccccc-cccc-4ccc-8ccc-ccccccccccc2',
                          'dddddddd-dddd-4ddd-8ddd-ddddddddddd1')
        session = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1'
        sql(f"""
INSERT INTO catalog.principals(id,oidc_issuer,oidc_subject) VALUES
 ('{p1}','migration-test','merge-p1'),('{p2}','migration-test','merge-p2');
INSERT INTO catalog.assets(id,owner_id,filename,mime_type,tags,rating,rating_manual,status,created_at) VALUES
 ('{a1}','{p1}','one.png','image/png',ARRAY['one'],'general',true,'ready',now()-interval '3 minutes'),
 ('{a2}','{p1}','two.png','image/png',ARRAY['two'],'explicit',false,'ready',now()-interval '2 minutes'),
 ('{a3}','{p2}','other.png','image/png',ARRAY['private'],'sensitive',true,'ready',now()-interval '1 minute'),
 ('{a4}','{p1}','four.png','image/png',ARRAY['four'],'general',true,'ready',now()-interval '1 minute'),
 ('{s1}','{p1}','series','application/vnd.ocms.series','{{}}','unrated',false,'ready',now());
INSERT INTO catalog.asset_originals(asset_id,blob_id) VALUES
 ('{a1}','{b1}'),('{a2}','{b1}'),('{a3}','{b1}'),('{a4}','{b2}');
INSERT INTO catalog.asset_characters(asset_id,name,position) VALUES
 ('{a1}','hero-one',0),('{a2}','hero-two',0);
INSERT INTO catalog.asset_favorites(principal_id,asset_id,created_at) VALUES
 ('{p1}','{a1}','2020-01-01');
INSERT INTO catalog.content_groups(id,principal_id,name) VALUES ('{g1}','{p1}','merged');
INSERT INTO catalog.asset_groups(group_id,principal_id,asset_id) VALUES ('{g1}','{p1}','{a1}');
INSERT INTO catalog.default_group_exclusions(principal_id,asset_id) VALUES ('{p1}','{a1}');
INSERT INTO catalog.grants(asset_id,principal_id,permission) VALUES ('{a1}','{p2}','read');
INSERT INTO catalog.upload_sessions(id,asset_id,expected_size,state) VALUES ('{session}','{a1}',1,'completed');
INSERT INTO catalog.series(asset_id,kind,version) VALUES ('{s1}','collection',1);
INSERT INTO catalog.series_members(series_id,asset_id,position,composite) VALUES
 ('{s1}','{a1}',0,false),('{s1}','{a4}',1,false);
""")

        def visible(principal, extra=''):
            return sql(f"""SELECT count(*)::text||':'||coalesce(string_agg(id::text,',' ORDER BY id),'') FROM (
 SELECT DISTINCT CASE WHEN a.series_kind='' AND o.blob_id IS NOT NULL THEN 'blob:'||o.blob_id::text ELSE 'asset:'||a.id::text END AS id
 FROM catalog.display_assets a LEFT JOIN catalog.asset_originals o ON o.asset_id=a.id
 WHERE a.deleted_at IS NULL AND a.series_kind='' AND (a.owner_id='{principal}' OR EXISTS(SELECT 1 FROM catalog.grants gr WHERE gr.asset_id=a.id AND gr.principal_id='{principal}')) {extra}
) x""")

        before = {name: visible(p1, extra) for name, extra in {
            'all': '', 'tag-one': "AND 'one'=ANY(a.tags)", 'tag-two': "AND 'two'=ANY(a.tags)",
            'favorite': f"AND EXISTS(SELECT 1 FROM catalog.asset_favorites f WHERE f.principal_id='{p1}' AND f.asset_id=a.id)",
            'group': f"AND EXISTS(SELECT 1 FROM catalog.asset_groups g WHERE g.principal_id='{p1}' AND g.asset_id=a.id)",
        }.items()}
        before_p2 = visible(p2)
        shutil.move(str(stash015 / merge.name), merge)
        run('up')
        after = {name: visible(p1, extra) for name, extra in {
            'all': '', 'tag-one': "AND 'one'=ANY(a.tags)", 'tag-two': "AND 'two'=ANY(a.tags)",
            'favorite': f"AND EXISTS(SELECT 1 FROM catalog.asset_favorites f WHERE f.principal_id='{p1}' AND f.asset_id=a.id)",
            'group': f"AND EXISTS(SELECT 1 FROM catalog.asset_groups g WHERE g.principal_id='{p1}' AND g.asset_id=a.id)",
        }.items()}
        assert before == after and visible(p2) == before_p2, (before, after, visible(p2), before_p2)
        merged_meta = sql(f"SELECT tags::text||'|'||characters::text FROM (SELECT tags,ARRAY(SELECT name FROM catalog.asset_characters WHERE asset_id='{a2}' ORDER BY position,name) AS characters FROM catalog.assets WHERE id='{a2}') x")
        assert merged_meta == '{two,one}|{hero-two,hero-one}', merged_meta
        assert sql(f"SELECT string_agg(filename,',') FROM catalog.asset_aliases WHERE asset_id='{a2}'") == 'one.png'
        assert sql(f"SELECT rating FROM catalog.assets WHERE id='{a2}'") == 'explicit'
        assert sql(f"SELECT deleted_at IS NOT NULL FROM catalog.assets WHERE id='{a1}'") == 't'
        assert sql(f"SELECT count(*) FROM catalog.assets WHERE id='{a3}' AND deleted_at IS NULL") == '1'
        assert sql(f"SELECT count(*) FROM catalog.asset_favorites WHERE principal_id='{p1}' AND asset_id='{a2}'") == '1'
        assert sql(f"SELECT count(*) FROM catalog.asset_groups WHERE group_id='{g1}' AND asset_id='{a2}'") == '1'
        assert sql(f"SELECT count(*) FROM catalog.grants WHERE asset_id='{a2}' AND principal_id='{p2}' AND permission='read'") == '1'
        assert sql(f"SELECT asset_id::text FROM catalog.upload_sessions WHERE id='{session}'") == a2
        assert sql(f"SELECT string_agg(asset_id::text,',' ORDER BY position) FROM catalog.series_members WHERE series_id='{s1}'") == a2 + ',' + a4
        assert sql(f"SELECT count(*) FROM catalog.default_group_exclusions WHERE asset_id='{a2}'") == '0'
        check('015 merges same-owner duplicates, preserves visible Blob sets and migrates metadata/ACL')

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
