BEGIN;
-- Duplicate registrations of the same content are merged into one Asset. The
-- surviving Asset keeps its filename; the other names remain visible as aliases.
CREATE TABLE catalog.asset_aliases (
 asset_id uuid NOT NULL REFERENCES catalog.assets(id) ON DELETE CASCADE,
 filename text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(asset_id,filename)
);
CREATE INDEX asset_aliases_asset ON catalog.asset_aliases(asset_id);
GRANT ALL ON catalog.asset_aliases TO catalog_app;

-- Merge one same-owner Asset into another and retire the duplicate. Labels,
-- favorites, groups and series memberships are unioned; names become aliases.
-- Default group exclusions keep the old "visible if any copy is visible" rule.
CREATE FUNCTION catalog.merge_asset(keep_id uuid, duplicate_id uuid) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
 keep catalog.assets%ROWTYPE;
 duplicate catalog.assets%ROWTYPE;
 merged_tags text[];
 merged_metadata jsonb;
 merged_rating text;
 merged_rating_manual boolean;
 merged_wd14_tagged boolean;
 merged_wd14_characters_tagged boolean;
 merged_wd14_rated boolean;
 affected_series uuid[];
 principal uuid;
BEGIN
 IF keep_id=duplicate_id THEN
  RETURN keep_id;
 END IF;
 SELECT * INTO keep FROM catalog.assets WHERE id=keep_id AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN
  RETURN keep_id;
 END IF;
 SELECT * INTO duplicate FROM catalog.assets WHERE id=duplicate_id AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN
  RETURN keep_id;
 END IF;
 IF keep.owner_id<>duplicate.owner_id THEN
  RAISE EXCEPTION 'cannot merge Assets with different owners';
 END IF;

 merged_tags:=ARRAY(
  SELECT t FROM unnest(keep.tags) WITH ORDINALITY AS existing(t,n)
  GROUP BY t ORDER BY min(n) LIMIT 512
 )||ARRAY(
  SELECT t FROM unnest(duplicate.tags) WITH ORDINALITY AS proposed(t,n)
  WHERE NOT(t=ANY(keep.tags))
  GROUP BY t ORDER BY min(n)
  LIMIT greatest(0,512-cardinality(keep.tags))
 );
 merged_metadata:=duplicate.metadata||keep.metadata;
 merged_rating:=keep.rating;
 IF (CASE duplicate.rating WHEN 'explicit' THEN 3 WHEN 'questionable' THEN 2 WHEN 'sensitive' THEN 1 WHEN 'general' THEN 0 ELSE -1 END)>
    (CASE keep.rating WHEN 'explicit' THEN 3 WHEN 'questionable' THEN 2 WHEN 'sensitive' THEN 1 WHEN 'general' THEN 0 ELSE -1 END) THEN
  merged_rating:=duplicate.rating;
 END IF;
 merged_rating_manual:=keep.rating_manual OR duplicate.rating_manual;
 merged_wd14_tagged:=keep.wd14_tagged OR duplicate.wd14_tagged;
 merged_wd14_characters_tagged:=keep.wd14_characters_tagged OR duplicate.wd14_characters_tagged;
 merged_wd14_rated:=keep.wd14_rated OR duplicate.wd14_rated;

 IF keep.filename<>duplicate.filename THEN
  INSERT INTO catalog.asset_aliases(asset_id,filename) VALUES(keep_id,duplicate.filename) ON CONFLICT DO NOTHING;
 END IF;

 INSERT INTO catalog.asset_favorites AS f(principal_id,asset_id,created_at)
 SELECT principal_id,keep_id,created_at FROM catalog.asset_favorites WHERE asset_id=duplicate_id
 ON CONFLICT(principal_id,asset_id) DO UPDATE SET created_at=greatest(f.created_at,excluded.created_at);
 DELETE FROM catalog.asset_favorites WHERE asset_id=duplicate_id;

 INSERT INTO catalog.asset_groups(group_id,principal_id,asset_id)
 SELECT group_id,principal_id,keep_id FROM catalog.asset_groups WHERE asset_id=duplicate_id
 ON CONFLICT DO NOTHING;
 DELETE FROM catalog.asset_groups WHERE asset_id=duplicate_id;

 INSERT INTO catalog.grants AS g(asset_id,principal_id,permission)
 SELECT keep_id,principal_id,permission FROM catalog.grants WHERE asset_id=duplicate_id
 ON CONFLICT(asset_id,principal_id) DO UPDATE SET permission=CASE
  WHEN g.permission='admin' OR excluded.permission='admin' THEN 'admin'
  WHEN g.permission='write' OR excluded.permission='write' THEN 'write'
  ELSE 'read' END;
 DELETE FROM catalog.grants WHERE asset_id=duplicate_id;

 FOR principal IN
  SELECT DISTINCT principal_id FROM catalog.default_group_exclusions WHERE asset_id IN(keep_id,duplicate_id)
 LOOP
  IF NOT(EXISTS(SELECT 1 FROM catalog.default_group_exclusions WHERE asset_id=keep_id AND principal_id=principal)
      AND EXISTS(SELECT 1 FROM catalog.default_group_exclusions WHERE asset_id=duplicate_id AND principal_id=principal)) THEN
   DELETE FROM catalog.default_group_exclusions WHERE asset_id=keep_id AND principal_id=principal;
  END IF;
 END LOOP;
 DELETE FROM catalog.default_group_exclusions WHERE asset_id=duplicate_id;

 -- Keep the surviving Asset's character order, then append the duplicate's.
 WITH removed AS (
  DELETE FROM catalog.asset_characters WHERE asset_id IN(keep_id,duplicate_id)
  RETURNING asset_id,name,position
 )
 INSERT INTO catalog.asset_characters(asset_id,name,position)
 SELECT keep_id,name,(row_number() OVER(ORDER BY ord,name))::int-1
 FROM(
  SELECT name,min(position+CASE WHEN asset_id=keep_id THEN 0 ELSE 100000 END) AS ord
  FROM removed GROUP BY name ORDER BY ord,name LIMIT 512
 ) merged;

 affected_series:=ARRAY(SELECT DISTINCT series_id FROM catalog.series_members WHERE asset_id IN(keep_id,duplicate_id));
 UPDATE catalog.series_members m SET asset_id=keep_id
 WHERE m.asset_id=duplicate_id AND NOT m.composite
  AND NOT EXISTS(SELECT 1 FROM catalog.series_members k WHERE k.series_id=m.series_id AND k.asset_id=keep_id);
 UPDATE catalog.series_members m SET asset_id=keep_id
 WHERE m.asset_id=duplicate_id AND m.composite
  AND NOT EXISTS(SELECT 1 FROM catalog.series_members k WHERE k.asset_id=keep_id AND k.composite)
  AND NOT EXISTS(SELECT 1 FROM catalog.series_members k WHERE k.series_id=m.series_id AND k.asset_id=keep_id);
 DELETE FROM catalog.series_members WHERE asset_id=duplicate_id;
 UPDATE catalog.series SET version=version+1 WHERE asset_id=ANY(affected_series);

 UPDATE catalog.upload_sessions u SET asset_id=keep_id
 WHERE u.asset_id=duplicate_id
  AND NOT EXISTS(SELECT 1 FROM catalog.upload_sessions k WHERE k.asset_id=keep_id AND k.idempotency_key=u.idempotency_key);

 UPDATE catalog.assets SET tags=merged_tags,metadata=merged_metadata,rating=merged_rating,
  rating_manual=merged_rating_manual,wd14_tagged=merged_wd14_tagged,
  wd14_characters_tagged=merged_wd14_characters_tagged,wd14_rated=merged_wd14_rated,
  updated_at=now()
 WHERE id=keep_id;
 UPDATE catalog.assets SET status='deleted',deleted_at=now(),updated_at=now() WHERE id=duplicate_id;
 RETURN keep_id;
END $$;
GRANT EXECUTE ON FUNCTION catalog.merge_asset(uuid,uuid) TO catalog_app;

-- Existing same-owner duplicates collapse to the newest live Asset. A visible
-- duplicate is preferred over a hidden composite member as the survivor.
DO $$
DECLARE
 grp record;
 keep_id uuid;
 duplicate_id uuid;
BEGIN
 FOR grp IN
  SELECT a.owner_id,o.blob_id,array_agg(a.id ORDER BY a.created_at DESC,a.id DESC) AS ids
  FROM catalog.assets a JOIN catalog.asset_originals o ON o.asset_id=a.id
  WHERE a.deleted_at IS NULL
  GROUP BY a.owner_id,o.blob_id HAVING count(*)>1
 LOOP
  SELECT a.id INTO keep_id FROM catalog.assets a
  WHERE a.id=ANY(grp.ids)
   AND NOT EXISTS(SELECT 1 FROM catalog.series_members m WHERE m.asset_id=a.id AND m.composite)
  ORDER BY a.created_at DESC,a.id DESC LIMIT 1;
  IF keep_id IS NULL THEN
   SELECT a.id INTO keep_id FROM catalog.assets a WHERE a.id=ANY(grp.ids)
   ORDER BY a.created_at DESC,a.id DESC LIMIT 1;
  END IF;
  FOREACH duplicate_id IN ARRAY grp.ids LOOP
   IF duplicate_id<>keep_id THEN
    PERFORM catalog.merge_asset(keep_id,duplicate_id);
   END IF;
  END LOOP;
 END LOOP;
END $$;
COMMIT;
