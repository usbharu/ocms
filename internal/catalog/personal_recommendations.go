package catalog

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"github.com/jackc/pgx/v5"
	"net/http"
	"sort"

	"ocms/internal/contracts"
	"ocms/internal/platform"
)

// A repeatable-read snapshot binds ACL-filtered features to their structure. The fingerprint also
// includes display filters so persisted sessions cannot survive rating changes.
func (s *Service) recommendationDataset(w http.ResponseWriter, r *http.Request) {
	if !guard(w, r) {
		return
	}
	tx, err := s.DB.BeginTx(r.Context(), pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	rows, err := tx.Query(r.Context(), selectAsset+`WHERE `+displayed+` ORDER BY a.id`, user(r))
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	defer rows.Close()
	assets := []contracts.RecommendationInput{}
	for rows.Next() {
		a, err := scanAsset(rows)
		if err != nil {
			platform.RespondError(w, err)
			return
		}
		sort.Strings(a.Tags)
		sort.Strings(a.Characters)
		assets = append(assets, contracts.RecommendationInput{ID: a.ID, BlobID: a.BlobID, BlobIDs: a.BlobIDs, SeriesKind: a.SeriesKind, MemberIDs: a.MemberIDs, Version: a.SeriesVersion, Tags: a.Tags, Characters: a.Characters, Favorite: a.IsFavorite, MIME: a.MIME, Rating: a.Rating})
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
