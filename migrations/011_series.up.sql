BEGIN;
CREATE TABLE catalog.series (
 asset_id uuid PRIMARY KEY REFERENCES catalog.assets(id),
 kind text NOT NULL CHECK(kind IN ('collection','composite')),
 version bigint NOT NULL DEFAULT 1
);
CREATE TABLE catalog.series_members (
 series_id uuid NOT NULL REFERENCES catalog.series(asset_id),
 asset_id uuid NOT NULL REFERENCES catalog.assets(id),
 position integer NOT NULL CHECK(position>=0),
 composite boolean NOT NULL,
 PRIMARY KEY(series_id,asset_id), UNIQUE(series_id,position),
 CHECK(series_id<>asset_id)
);
CREATE UNIQUE INDEX series_members_one_composite ON catalog.series_members(asset_id) WHERE composite;
CREATE INDEX series_members_asset ON catalog.series_members(asset_id);
-- A collection can contain a composite, but never another collection.
CREATE VIEW catalog.series_leaves AS
 SELECT m.series_id,coalesce(n.asset_id,m.asset_id) AS asset_id,
 m.position AS position,coalesce(n.position,0) AS subposition
 FROM catalog.series_members m
 LEFT JOIN catalog.series_members n ON n.series_id=m.asset_id
 JOIN catalog.assets a ON a.id=coalesce(n.asset_id,m.asset_id) AND a.deleted_at IS NULL;
CREATE VIEW catalog.display_assets AS
 SELECT a.id,a.owner_id,a.filename,a.mime_type,a.status,a.created_at,a.updated_at,a.deleted_at,
 CASE WHEN s.asset_id IS NULL THEN a.tags ELSE ARRAY(
 SELECT DISTINCT t FROM catalog.series_leaves l JOIN catalog.assets x ON x.id=l.asset_id
 CROSS JOIN LATERAL unnest(x.tags) t WHERE l.series_id=a.id ORDER BY t) END AS tags,
 CASE WHEN s.asset_id IS NULL THEN a.rating ELSE coalesce((SELECT x.rating
 FROM catalog.series_leaves l JOIN catalog.assets x ON x.id=l.asset_id WHERE l.series_id=a.id
 ORDER BY CASE x.rating WHEN 'explicit' THEN 3 WHEN 'questionable' THEN 2 WHEN 'sensitive' THEN 1 WHEN 'general' THEN 0 ELSE -1 END DESC LIMIT 1),'unrated') END AS rating,
 CASE WHEN s.asset_id IS NULL THEN ARRAY(SELECT c.name FROM catalog.asset_characters c WHERE c.asset_id=a.id ORDER BY c.position,c.name)
 ELSE ARRAY(SELECT DISTINCT c.name FROM catalog.asset_characters c WHERE c.asset_id=a.id OR
 c.asset_id IN (SELECT asset_id FROM catalog.series_leaves WHERE series_id=a.id) ORDER BY c.name) END AS characters,
 coalesce(s.kind,'') AS series_kind,coalesce(s.version,0) AS series_version,
 coalesce((SELECT m.series_id FROM catalog.series_members m WHERE m.asset_id=a.id AND m.composite)::text,'') AS composite_id,
 coalesce((SELECT l.asset_id FROM catalog.series_leaves l WHERE l.series_id=a.id ORDER BY l.position,l.subposition LIMIT 1)::text,'') AS cover_asset_id,
 ARRAY(SELECT o.blob_id::text FROM catalog.asset_originals o WHERE o.asset_id=a.id OR o.asset_id IN
 (SELECT asset_id FROM catalog.series_leaves WHERE series_id=a.id) ORDER BY o.blob_id,o.asset_id) AS blob_ids,
 ARRAY(SELECT m.asset_id::text FROM catalog.series_members m WHERE m.series_id=a.id ORDER BY m.position) AS member_ids,
 ARRAY(SELECT o.asset_id::text FROM catalog.asset_originals o WHERE o.asset_id=a.id OR o.asset_id IN
 (SELECT asset_id FROM catalog.series_leaves WHERE series_id=a.id) ORDER BY o.blob_id,o.asset_id) AS blob_asset_ids
 FROM catalog.assets a LEFT JOIN catalog.series s ON s.asset_id=a.id;
GRANT ALL ON catalog.series,catalog.series_members TO catalog_app;
GRANT SELECT ON catalog.series_leaves,catalog.display_assets TO catalog_app;
COMMIT;
