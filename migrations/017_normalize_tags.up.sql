BEGIN;
-- CL Tagger v2 returns general tags and character names with spaces, while WD14
-- used underscores. Store every automatic and manual label in the WD14 form so
-- lists, searches and cached results compare the same names.
UPDATE catalog.assets a
SET tags = coalesce((
 SELECT array_agg(n.name ORDER BY n.position)
 FROM (
  SELECT replace(btrim(t.name), ' ', '_') AS name, min(t.position) AS position
  FROM unnest(a.tags) WITH ORDINALITY AS t(name, position)
  WHERE btrim(t.name) <> ''
  GROUP BY replace(btrim(t.name), ' ', '_')
 ) n
), '{}'::text[])
WHERE EXISTS (
 SELECT 1 FROM unnest(a.tags) AS t(name)
 WHERE btrim(t.name) = '' OR t.name <> replace(btrim(t.name), ' ', '_')
);

-- Remove later duplicates before renaming so the primary key stays unique.
WITH affected AS MATERIALIZED (
 SELECT DISTINCT asset_id FROM catalog.asset_characters
 WHERE name <> replace(btrim(name), ' ', '_')
), ranked AS (
 SELECT c.asset_id, c.name, row_number() OVER (
  PARTITION BY c.asset_id, replace(btrim(c.name), ' ', '_')
  ORDER BY c.position, c.name
 ) AS duplicate
 FROM catalog.asset_characters c JOIN affected a ON a.asset_id = c.asset_id
)
DELETE FROM catalog.asset_characters c
USING ranked d
WHERE c.asset_id = d.asset_id AND c.name = d.name AND d.duplicate > 1;

UPDATE catalog.asset_characters
SET name = replace(btrim(name), ' ', '_')
WHERE name <> replace(btrim(name), ' ', '_');

-- Normalize cached inference results too, so duplicate Assets created later
-- receive the same labels without rerunning the tagger.
UPDATE catalog.wd14_results r
SET tags = coalesce((
 SELECT array_agg(n.name ORDER BY n.position)
 FROM (
  SELECT replace(btrim(t.name), ' ', '_') AS name, min(t.position) AS position
  FROM unnest(r.tags) WITH ORDINALITY AS t(name, position)
  WHERE btrim(t.name) <> ''
  GROUP BY replace(btrim(t.name), ' ', '_')
 ) n
), '{}'::text[])
WHERE EXISTS (
 SELECT 1 FROM unnest(r.tags) AS t(name)
 WHERE btrim(t.name) = '' OR t.name <> replace(btrim(t.name), ' ', '_')
);

UPDATE catalog.wd14_character_results r
SET characters = coalesce((
 SELECT array_agg(n.name ORDER BY n.position)
 FROM (
  SELECT replace(btrim(t.name), ' ', '_') AS name, min(t.position) AS position
  FROM unnest(r.characters) WITH ORDINALITY AS t(name, position)
  WHERE btrim(t.name) <> ''
  GROUP BY replace(btrim(t.name), ' ', '_')
 ) n
), '{}'::text[])
WHERE EXISTS (
 SELECT 1 FROM unnest(r.characters) AS t(name)
 WHERE btrim(t.name) = '' OR t.name <> replace(btrim(t.name), ' ', '_')
);
COMMIT;
