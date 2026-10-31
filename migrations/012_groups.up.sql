BEGIN;
CREATE TABLE catalog.content_groups (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 principal_id uuid NOT NULL REFERENCES catalog.principals(id) ON DELETE CASCADE,
 name text NOT NULL CHECK (name=btrim(name) AND length(name) BETWEEN 1 AND 100 AND lower(name) NOT IN ('default','all')),
 UNIQUE(principal_id,name),
 UNIQUE(id,principal_id)
);
CREATE TABLE catalog.asset_groups (
 group_id uuid NOT NULL,
 principal_id uuid NOT NULL,
 asset_id uuid NOT NULL REFERENCES catalog.assets(id) ON DELETE CASCADE,
 PRIMARY KEY(group_id,asset_id),
 FOREIGN KEY(group_id,principal_id) REFERENCES catalog.content_groups(id,principal_id) ON DELETE CASCADE
);
CREATE INDEX asset_groups_principal_asset ON catalog.asset_groups(principal_id,asset_id);
CREATE TABLE catalog.default_group_exclusions (
 principal_id uuid NOT NULL REFERENCES catalog.principals(id) ON DELETE CASCADE,
 asset_id uuid NOT NULL REFERENCES catalog.assets(id) ON DELETE CASCADE,
 PRIMARY KEY(principal_id,asset_id)
);
GRANT ALL ON catalog.content_groups,catalog.asset_groups,catalog.default_group_exclusions TO catalog_app;
COMMIT;
