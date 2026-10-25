BEGIN;
-- Characters are independent metadata, never mixed into Asset tags.
CREATE TABLE catalog.asset_characters (
 asset_id uuid NOT NULL REFERENCES catalog.assets(id) ON DELETE CASCADE,
 name text NOT NULL CHECK(btrim(name)<>'' AND octet_length(name)<=256),
 position integer NOT NULL,
 PRIMARY KEY(asset_id,name)
);
CREATE INDEX asset_characters_name ON catalog.asset_characters(name,asset_id);
CREATE TABLE catalog.wd14_character_results (
 blob_id uuid PRIMARY KEY,
 characters text[] NOT NULL,
 model_id text NOT NULL,
 model_revision text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON catalog.asset_characters,catalog.wd14_character_results TO catalog_app;
ALTER TABLE catalog.assets ADD COLUMN wd14_characters_tagged boolean NOT NULL DEFAULT false;
-- Reuse existing inference jobs; retain general-tag application markers and manual edits.
UPDATE media.processing_jobs SET status='queued',attempts=0,available_at=now(),
 locked_until=NULL,lease_token=NULL,error_code=NULL,updated_at=now()
 WHERE job_type='tags.generate' AND status='completed';
COMMIT;
