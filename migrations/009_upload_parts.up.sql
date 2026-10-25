BEGIN;
CREATE TABLE storage.upload_parts (
 upload_id uuid NOT NULL,
 part_number integer NOT NULL CHECK (part_number >= 0),
 object_key text NOT NULL UNIQUE,
 size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 8388608),
 sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
 master_key_id text NOT NULL,
 encrypted_dek bytea NOT NULL,
 dek_wrap_nonce bytea NOT NULL,
 data_nonce bytea NOT NULL,
 ready boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (upload_id, part_number)
);
CREATE INDEX upload_parts_expiry ON storage.upload_parts(created_at);
GRANT ALL ON storage.upload_parts TO transfer_app;
COMMIT;
