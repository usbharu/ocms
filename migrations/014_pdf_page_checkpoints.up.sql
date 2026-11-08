BEGIN;
-- Derived OCR/index data only. Original images remain encrypted in Transfer.
CREATE TABLE media.pdf_page_checkpoints (
 job_id uuid NOT NULL REFERENCES media.processing_jobs(id) ON DELETE CASCADE,
 pipeline_version text NOT NULL,
 page integer NOT NULL CHECK (page > 0),
 pages integer NOT NULL CHECK (pages >= page),
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (job_id, pipeline_version, page)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON media.pdf_page_checkpoints TO media_app;
COMMIT;
