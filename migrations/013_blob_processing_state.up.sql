BEGIN;
CREATE SEQUENCE media.blob_state_revision;
CREATE TABLE media.blob_state_outbox (
 blob_id uuid PRIMARY KEY,
 revision bigint NOT NULL DEFAULT nextval('media.blob_state_revision'),
 available_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX blob_state_outbox_available ON media.blob_state_outbox(available_at, blob_id);
CREATE TABLE media.blob_state_settings (
 singleton boolean PRIMARY KEY CHECK (singleton),
 semantic_search_disabled boolean NOT NULL
);
INSERT INTO media.blob_state_settings VALUES (true, false);

CREATE FUNCTION media.queue_blob_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'UPDATE' AND NEW.status = OLD.status THEN
  RETURN NULL;
 END IF;
 INSERT INTO media.blob_state_outbox(blob_id) VALUES (COALESCE(NEW.source_blob_id, OLD.source_blob_id))
 ON CONFLICT (blob_id) DO UPDATE SET revision=nextval('media.blob_state_revision'),available_at=now();
 RETURN NULL;
END;
$$;
CREATE TRIGGER queue_blob_state AFTER INSERT OR UPDATE OF status OR DELETE ON media.processing_jobs
 FOR EACH ROW EXECUTE FUNCTION media.queue_blob_state();

-- Seed a single reconciliation for all existing Jobs.
INSERT INTO media.blob_state_outbox(blob_id) SELECT DISTINCT source_blob_id FROM media.processing_jobs;

CREATE TABLE catalog.blob_processing_states (
 blob_id uuid PRIMARY KEY,
 revision bigint NOT NULL CHECK (revision > 0),
 status text NOT NULL CHECK (status IN ('processing','ready','failed'))
);

GRANT SELECT,INSERT,UPDATE,DELETE ON media.blob_state_outbox TO media_app;
GRANT SELECT,INSERT,UPDATE ON media.blob_state_settings TO media_app;
GRANT USAGE ON SEQUENCE media.blob_state_revision TO media_app;
GRANT SELECT,INSERT,UPDATE ON catalog.blob_processing_states TO catalog_app;
COMMIT;
