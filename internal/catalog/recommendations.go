package catalog

import (
	"net/http"
	"ocms/internal/platform"
)

// Metadata candidates are ranked per Asset, never per shared Blob. The source
// and candidate ACLs are enforced here rather than inferred by Search.
func (s *Service) recommendationCandidates(w http.ResponseWriter, r *http.Request) {
	if !guard(w, r) {
		return
	}
	source, err := s.readable(r.Context(), r.PathValue("id"), user(r))
	if assetError(w, err) {
		return
	}
	rows, err := s.DB.Query(r.Context(), `WITH candidates AS (
 SELECT a.id,
 ARRAY(SELECT DISTINCT t FROM unnest(a.tags) t) AS tags,
 a.characters
 FROM catalog.display_assets a LEFT JOIN catalog.asset_originals o ON o.asset_id=a.id
 WHERE `+displayed+` AND a.id<>$2 AND ($5::uuid IS NULL OR o.blob_id IS DISTINCT FROM $5::uuid)
 AND (a.tags && $3::text[] OR a.characters && $4::text[])
 ), ranked AS (
 SELECT id, 0.3 * (SELECT count(*)::float8 FROM (SELECT unnest(tags) INTERSECT SELECT unnest($3::text[])) x)
 / greatest(1,(SELECT count(*) FROM (SELECT unnest(tags) UNION SELECT unnest($3::text[])) x))
 + 0.5 * (SELECT count(*)::float8 FROM (SELECT unnest(characters) INTERSECT SELECT unnest($4::text[])) x)
 / greatest(1,(SELECT count(*) FROM (SELECT unnest(characters) UNION SELECT unnest($4::text[])) x)) AS score FROM candidates
 ) SELECT id::text FROM ranked WHERE score>0 ORDER BY score DESC,id LIMIT 1000`, user(r), source.ID, source.Tags, source.Characters, source.BlobID)
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			platform.RespondError(w, err)
			return
		}
		ids = append(ids, id)
	}
	if rows.Err() != nil {
		platform.RespondError(w, rows.Err())
		return
	}
	platform.JSON(w, 200, map[string]any{"asset_ids": ids})
}
