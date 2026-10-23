BEGIN;
-- Inference results are shared, but every Asset receives an independent, editable copy.
ALTER TABLE catalog.assets ADD COLUMN wd14_tagged boolean NOT NULL DEFAULT false;
CREATE TABLE catalog.wd14_results (
 blob_id uuid PRIMARY KEY,
 tags text[] NOT NULL,
 model_id text NOT NULL,
 model_revision text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON catalog.wd14_results TO catalog_app;
ALTER TABLE media.processing_jobs DROP CONSTRAINT processing_jobs_job_type_check;
ALTER TABLE media.processing_jobs ADD CHECK(job_type IN ('media.process','embedding.generate','tags.generate'));
-- Existing successfully decoded media are tagged without repeating transcodes or embeddings.
INSERT INTO media.processing_jobs(event_id,source_blob_id,job_type,traceparent)
 SELECT j.event_id,j.source_blob_id,'tags.generate',j.traceparent
 FROM media.processing_jobs j JOIN media.blob_metadata m ON m.blob_id=j.source_blob_id
 WHERE j.job_type='media.process' AND j.status='completed'
 AND (m.mime_type LIKE 'image/%' OR m.mime_type LIKE 'video/%' OR m.mime_type='application/pdf')
 ON CONFLICT DO NOTHING;
COMMIT;
