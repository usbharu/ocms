package catalog

const applyWD14Rating = `UPDATE catalog.assets a SET rating=CASE WHEN a.rating_manual THEN a.rating ELSE r.rating END,wd14_rated=true,updated_at=now()
 FROM catalog.asset_originals o JOIN catalog.wd14_rating_results r ON r.blob_id=o.blob_id
 WHERE a.id=o.asset_id AND o.blob_id=$1 AND NOT a.wd14_rated AND a.deleted_at IS NULL AND a.id=ANY($2::uuid[])`
