package catalog

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"sort"

	"github.com/jackc/pgx/v5"
	"ocms/internal/contracts"
	"ocms/internal/platform"
)

// Resolve the readable favorites once, including favorites on composite
// members. A favorite applies to the Asset that stores it.
const recommendationDatasetSelect = `
SELECT a.id,o.blob_id,` + displayBlobIDs + `,a.series_kind,a.member_ids,a.series_version,
       a.tags,a.characters,
       CASE WHEN a.series_kind='' THEN f.asset_id IS NOT NULL ELSE ` + favoriteCondition + ` END,
       a.mime_type,a.rating
FROM catalog.display_assets a
LEFT JOIN catalog.asset_originals o ON o.asset_id=a.id
LEFT JOIN catalog.asset_favorites f ON f.asset_id=a.id AND f.principal_id=$1`

// A repeatable-read snapshot binds ACL-filtered features to their structure. The fingerprint also
// includes display filters so persisted sessions cannot survive rating changes.
func (s *Service) recommendationDataset(w http.ResponseWriter, r *http.Request) {
	if !guard(w, r) {
		return
	}
	group, ok := s.requestGroup(w, r)
	if !ok {
		return
	}
	tx, err := s.DB.BeginTx(r.Context(), pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	rows, err := tx.Query(r.Context(), recommendationDatasetSelect+` WHERE `+displayed+` AND `+groupCondition(2)+` ORDER BY a.id`, user(r), group)
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	defer rows.Close()
	assets := []contracts.RecommendationInput{}
	for rows.Next() {
		var item contracts.RecommendationInput
		if err := rows.Scan(&item.ID, &item.BlobID, &item.BlobIDs, &item.SeriesKind, &item.MemberIDs, &item.Version, &item.Tags, &item.Characters, &item.Favorite, &item.MIME, &item.Rating); err != nil {
			platform.RespondError(w, err)
			return
		}
		sort.Strings(item.Tags)
		sort.Strings(item.Characters)
		assets = append(assets, item)
	}
	if rows.Err() != nil {
		platform.RespondError(w, rows.Err())
		return
	}
	var structure string
	err = tx.QueryRow(r.Context(), `SELECT coalesce(string_agg(a.id::text||a.updated_at::text||coalesce((SELECT string_agg(principal_id::text||permission,',' ORDER BY principal_id) FROM catalog.grants WHERE asset_id=a.id),''),';' ORDER BY a.id),'') FROM catalog.assets a WHERE `+allowed, user(r)).Scan(&structure)
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		platform.RespondError(w, err)
		return
	}
	raw, err := json.Marshal(struct {
		Assets    []contracts.RecommendationInput
		Structure string
	}{assets, structure})
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	hash := sha256.Sum256(raw)
	out := contracts.RecommendationDataset{Fingerprint: hex.EncodeToString(hash[:])}
	out.Unchanged = r.URL.Query().Get("fingerprint") == out.Fingerprint
	if !out.Unchanged {
		out.Assets = assets
	}
	platform.JSON(w, 200, out)
}
