BEGIN;
ALTER TABLE catalog.assets
 ADD COLUMN rating text NOT NULL DEFAULT 'unrated' CHECK(rating IN ('unrated','general','sensitive','questionable','explicit')),
 ADD COLUMN rating_manual boolean NOT NULL DEFAULT false,
 ADD COLUMN wd14_rated boolean NOT NULL DEFAULT false;
CREATE TABLE catalog.wd14_rating_results (
 blob_id uuid PRIMARY KEY,
 rating text NOT NULL CHECK(rating IN ('general','sensitive','questionable','explicit')),
 model_id text NOT NULL,
 model_revision text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON catalog.wd14_rating_results TO catalog_app;
UPDATE media.processing_jobs SET status='queued',attempts=0,available_at=now(),
 locked_until=NULL,lease_token=NULL,error_code=NULL,updated_at=now()
 WHERE job_type='tags.generate' AND status='completed';
COMMIT;
