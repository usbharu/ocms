BEGIN;
-- Replace the previous tagger's cached metadata and requeue completed tagging jobs.
-- Automatic tags are identified from the Blob-level inference results; manual tags
-- are kept unless they are identical to a previous automatic tag.
UPDATE catalog.assets a
SET tags = ARRAY(SELECT t FROM unnest(a.tags) AS t WHERE NOT (t = ANY(r.tags))),
    updated_at = now()
FROM catalog.asset_originals o
JOIN catalog.wd14_results r ON r.blob_id = o.blob_id
WHERE a.id = o.asset_id AND a.wd14_tagged;

DELETE FROM catalog.asset_characters c
USING catalog.asset_originals o, catalog.wd14_character_results r, catalog.assets a
WHERE c.asset_id = o.asset_id AND o.blob_id = r.blob_id AND a.id = o.asset_id
  AND a.wd14_characters_tagged AND c.name = ANY(r.characters);

UPDATE catalog.assets
SET rating = CASE WHEN rating_manual THEN rating ELSE 'unrated' END,
    wd14_tagged = false,
    wd14_characters_tagged = false,
    wd14_rated = false,
    updated_at = now()
WHERE wd14_tagged OR wd14_characters_tagged OR wd14_rated;

DELETE FROM catalog.wd14_results;
DELETE FROM catalog.wd14_character_results;
DELETE FROM catalog.wd14_rating_results;

UPDATE media.processing_jobs
SET status = 'queued', attempts = 0, available_at = now(),
    locked_until = NULL, lease_token = NULL, error_code = NULL, updated_at = now()
WHERE job_type = 'tags.generate' AND status = 'completed';
COMMIT;
