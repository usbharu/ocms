BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA catalog;
CREATE SCHEMA storage;
CREATE TABLE catalog.principals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL DEFAULT 'user',
 oidc_issuer text NOT NULL, oidc_subject text NOT NULL,
 UNIQUE(kind,oidc_issuer,oidc_subject)
);
CREATE TABLE catalog.assets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES catalog.principals,
 filename text NOT NULL, mime_type text NOT NULL, tags text[] NOT NULL DEFAULT '{}',
 metadata jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'pending'
 CHECK(status IN ('pending','uploading','stored','processing','ready','failed','deleted')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE TABLE catalog.asset_originals (
 asset_id uuid PRIMARY KEY REFERENCES catalog.assets, blob_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON catalog.asset_originals(blob_id);
CREATE TABLE catalog.grants (
 asset_id uuid REFERENCES catalog.assets, principal_id uuid REFERENCES catalog.principals,
 permission text NOT NULL CHECK(permission IN ('read','write','admin')), PRIMARY KEY(asset_id,principal_id)
);
CREATE TABLE catalog.upload_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),asset_id uuid NOT NULL REFERENCES catalog.assets,
 expected_size bigint NOT NULL CHECK(expected_size>=0), state text NOT NULL DEFAULT 'created'
 CHECK(state IN ('created','uploading','completed','failed','expired')),
 idempotency_key text, expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(asset_id,idempotency_key)
);
CREATE TABLE catalog.outbox_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), blob_id uuid NOT NULL, event_type text NOT NULL,
 traceparent text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz,
 UNIQUE(blob_id,event_type)
);
CREATE TABLE storage.blobs (
 id uuid PRIMARY KEY, sha256 bytea NOT NULL CHECK(octet_length(sha256)=32),
 size_bytes bigint NOT NULL CHECK(size_bytes>=0),bucket text NOT NULL,object_key text NOT NULL,
 s3_version_id text,cipher_version smallint NOT NULL DEFAULT 1 CHECK(cipher_version=1),
 master_key_id text NOT NULL,encrypted_dek bytea NOT NULL,
 dek_wrap_nonce bytea NOT NULL CHECK(octet_length(dek_wrap_nonce)=12),
 ctr_nonce_prefix bytea NOT NULL CHECK(octet_length(ctr_nonce_prefix)=8),
 status text NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','deleting')),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(sha256,size_bytes),UNIQUE(bucket,object_key)
);
-- Durable S3 write intent: written before PUT, retained until object cleanup succeeds.
CREATE TABLE storage.upload_objects (
 id uuid PRIMARY KEY, upload_id uuid NOT NULL, object_key text NOT NULL UNIQUE,
 blob_id uuid, state text NOT NULL CHECK(state IN ('writing','stored','duplicate')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON storage.upload_objects(upload_id) WHERE state='stored';
DO $$ BEGIN
 EXECUTE format('CREATE ROLE catalog_app LOGIN PASSWORD %L', current_setting('ocms.app_db_password'));
END $$;
DO $$ BEGIN
 EXECUTE format('CREATE ROLE transfer_app LOGIN PASSWORD %L', current_setting('ocms.app_db_password'));
END $$;
GRANT USAGE ON SCHEMA catalog TO catalog_app;
GRANT ALL ON ALL TABLES IN SCHEMA catalog TO catalog_app;
GRANT USAGE ON SCHEMA storage TO transfer_app;
GRANT ALL ON ALL TABLES IN SCHEMA storage TO transfer_app;
COMMIT;
