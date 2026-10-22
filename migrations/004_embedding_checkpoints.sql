BEGIN;
-- Only vectors and a digest of the input are persisted; no source text/media.
CREATE TABLE media.embedding_checkpoints (
 job_id uuid NOT NULL REFERENCES media.processing_jobs(id) ON DELETE CASCADE,
 model_id text NOT NULL, model_revision text NOT NULL, input_sha256 text NOT NULL,
 result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(job_id,model_id,model_revision,input_sha256)
);
GRANT ALL ON media.embedding_checkpoints TO media_app;
COMMIT;
