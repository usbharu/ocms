BEGIN;
CREATE EXTENSION IF NOT EXISTS pgroonga;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA media;
CREATE SCHEMA search;
SELECT format('CREATE ROLE media_app LOGIN PASSWORD %L', :'app_password') \gexec
SELECT format('CREATE ROLE search_app LOGIN PASSWORD %L', :'app_password') \gexec

CREATE TABLE media.processing_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_id uuid NOT NULL,source_blob_id uuid NOT NULL,
 job_type text NOT NULL CHECK(job_type IN ('media.process','embedding.generate')),
 pipeline_version integer NOT NULL DEFAULT 1,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','retry','completed','failed')),
 attempts integer NOT NULL DEFAULT 0,available_at timestamptz NOT NULL DEFAULT now(),locked_until timestamptz,
 lease_token uuid, error_code text,traceparent text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(source_blob_id,job_type,pipeline_version)
);
CREATE INDEX ON media.processing_jobs(available_at) WHERE status IN ('queued','retry','running');
CREATE TABLE media.blob_metadata (
 blob_id uuid PRIMARY KEY,mime_type text NOT NULL DEFAULT '',metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE media.renditions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),source_blob_id uuid NOT NULL,output_blob_id uuid NOT NULL,
 profile_id text NOT NULL,profile_version integer NOT NULL DEFAULT 1,encoder_version text NOT NULL,
 mime_type text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(source_blob_id,profile_id,profile_version,encoder_version)
);
CREATE TABLE search.passages (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,blob_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('pdf_text','ocr','transcript')),ordinal integer NOT NULL,
 page_number integer,start_ms bigint,end_ms bigint,content text NOT NULL,extractor_version integer NOT NULL DEFAULT 1,
 UNIQUE(blob_id,kind,ordinal,extractor_version)
);
CREATE INDEX ON search.passages USING pgroonga(content);
CREATE INDEX ON search.passages(blob_id);
CREATE TABLE search.perceptual_hashes (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,blob_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('image','video_frame','pdf_page')),ordinal integer NOT NULL,
 frame_ms bigint,page_number integer,algorithm_version integer NOT NULL DEFAULT 1,phash bit(64) NOT NULL,
 UNIQUE(blob_id,kind,ordinal,algorithm_version)
);
CREATE INDEX ON search.perceptual_hashes USING hnsw(phash bit_hamming_ops);
CREATE TABLE search.audio_fingerprints (
 blob_id uuid PRIMARY KEY,algorithm text NOT NULL DEFAULT 'chromaprint',algorithm_version integer NOT NULL DEFAULT 1,
 duration_ms bigint,fingerprint integer[] NOT NULL
);
CREATE TABLE search.embeddings (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,blob_id uuid NOT NULL,source_type text NOT NULL,
 ordinal integer NOT NULL,page_number integer,start_ms bigint,end_ms bigint,
 model_id text NOT NULL,model_revision text NOT NULL,
 vector_dimension smallint NOT NULL DEFAULT 768 CHECK(vector_dimension=768),embedding vector(768) NOT NULL,
 UNIQUE(blob_id,source_type,ordinal,model_id,model_revision)
);
CREATE INDEX ON search.embeddings USING hnsw(embedding vector_cosine_ops);
CREATE INDEX ON search.embeddings(blob_id);
GRANT USAGE ON SCHEMA media TO media_app;
GRANT ALL ON ALL TABLES IN SCHEMA media TO media_app;
GRANT USAGE ON SCHEMA search TO search_app;
GRANT ALL ON ALL TABLES IN SCHEMA search TO search_app;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA search TO search_app;
-- Transfer-generated derivatives use the same durable write intent protocol, but
-- have no browser Upload Session. The Job ID supplies their lock/reference context.
ALTER TABLE storage.upload_objects ADD COLUMN source_blob_id uuid;

COMMIT;
