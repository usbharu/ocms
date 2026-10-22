CREATE TABLE catalog.upload_request_keys (
 principal_id uuid NOT NULL REFERENCES catalog.principals,
 idempotency_key text NOT NULL,
 upload_id uuid NOT NULL REFERENCES catalog.upload_sessions,
 request jsonb NOT NULL,
 PRIMARY KEY(principal_id,idempotency_key)
);
GRANT ALL ON catalog.upload_request_keys TO catalog_app;
