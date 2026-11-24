BEGIN;
-- Discard cached inference results so completed tagging jobs are recomputed
-- with CL Tagger v2. Existing Asset tags, characters and ratings are edited
-- metadata and are deliberately kept; the new results are added on top of them.
UPDATE catalog.assets
SET wd14_tagged = false,
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
