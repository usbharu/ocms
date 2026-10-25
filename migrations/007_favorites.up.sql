BEGIN;
CREATE TABLE catalog.asset_favorites (
 principal_id uuid NOT NULL REFERENCES catalog.principals(id) ON DELETE CASCADE,
 asset_id uuid NOT NULL REFERENCES catalog.assets(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(principal_id,asset_id)
);
CREATE INDEX asset_favorites_recent ON catalog.asset_favorites(principal_id,created_at DESC,asset_id DESC);
GRANT ALL ON catalog.asset_favorites TO catalog_app;
COMMIT;
