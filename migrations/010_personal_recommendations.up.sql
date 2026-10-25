BEGIN;
CREATE TABLE search.recommendation_cache (
 principal_id uuid PRIMARY KEY,
 fingerprint text NOT NULL,
 engine_version text NOT NULL,
 pool jsonb NOT NULL,
 expires_at timestamptz NOT NULL
);
CREATE TABLE search.recommendation_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 principal_id uuid NOT NULL,
 fingerprint text NOT NULL,
 engine_version text NOT NULL,
 conditions jsonb NOT NULL,
 status text NOT NULL CHECK (status IN ('ready','insufficient_information')),
 asset_ids uuid[] NOT NULL,
 scores double precision[] NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
 CHECK (cardinality(asset_ids)=cardinality(scores))
);
CREATE INDEX recommendation_sessions_expiry ON search.recommendation_sessions(expires_at);
-- Retain only the first page as exposure history, independently of session TTL.
CREATE TABLE search.recommendation_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 principal_id uuid NOT NULL,
 asset_ids uuid[] NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recommendation_history_recent ON search.recommendation_history(principal_id,created_at DESC,id DESC);
GRANT ALL ON search.recommendation_cache,search.recommendation_sessions,search.recommendation_history TO search_app;
GRANT USAGE,SELECT ON SEQUENCE search.recommendation_history_id_seq TO search_app;
COMMIT;
