package catalog

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"sort"

	"ocms/internal/contracts"
	"ocms/internal/platform"
)

// One SELECT supplies a consistent ACL-filtered snapshot. The fingerprint also
// includes display filters so persisted sessions cannot survive rating changes.
func (s *Service) recommendationDataset(w http.ResponseWriter, r *http.Request) {
	if !guard(w, r) {
		return
	}
	rows, err := s.DB.Query(r.Context(), selectAsset+`WHERE `+allowed+` ORDER BY a.id`, user(r))
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
		assets = append(assets, contracts.RecommendationInput{ID: a.ID, BlobID: a.BlobID, Tags: a.Tags, Characters: a.Characters, Favorite: a.IsFavorite, MIME: a.MIME, Rating: a.Rating})
	}
	if rows.Err() != nil {
		platform.RespondError(w, rows.Err())
		return
	}
	raw, err := json.Marshal(assets)
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
