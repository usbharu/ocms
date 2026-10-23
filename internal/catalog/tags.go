package catalog

import (
	"net/http"
	"os"
	"strings"

	"ocms/internal/contracts"
	"ocms/internal/platform"
)

// Apply once, atomically, preserving concurrent edits and every Asset's own tags.
// Reconciliation also covers uploads racing with the inference result transaction.
const applyWD14Tags = `UPDATE catalog.assets a SET tags=a.tags || ARRAY(SELECT t FROM unnest(r.tags) WITH ORDINALITY AS proposed(t,n) WHERE NOT(t=ANY(a.tags)) GROUP BY t ORDER BY min(n) LIMIT greatest(0,512-cardinality(a.tags))),wd14_tagged=true,updated_at=now() FROM catalog.asset_originals o JOIN catalog.wd14_results r ON r.blob_id=o.blob_id WHERE a.id=o.asset_id AND o.blob_id=$1 AND NOT a.wd14_tagged AND a.deleted_at IS NULL`

func (s *Service) blobTags(w http.ResponseWriter, r *http.Request) {
	if !validID(r.PathValue("id")) {
		platform.Error(w, 404, "NOT_FOUND")
		return
	}
	var in struct {
		Tags     []string `json:"tags"`
		Model    string   `json:"model_id"`
		Revision string   `json:"model_revision"`
	}
	if !platform.Decode(w, r, &in) {
		return
	}
	if in.Model != contracts.TagModel || in.Revision != contracts.TagRevision || len(in.Tags) > 256 {
		platform.Error(w, 400, "INVALID_REQUEST")
		return
	}
	for _, tag := range in.Tags {
		if strings.TrimSpace(tag) == "" || len(tag) > 256 {
			platform.Error(w, 400, "INVALID_REQUEST")
			return
		}
	}
	if in.Tags == nil {
		in.Tags = []string{}
	}
	err := platform.Call(r.Context(), "POST", os.Getenv("MEDIA_URL")+"/internal/jobs/"+r.Header.Get("X-Job-ID")+"/authorize", "", map[string]string{"blob_id": r.PathValue("id"), "lease_token": r.Header.Get("X-Job-Lease")}, nil)
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	_, err = tx.Exec(r.Context(), `INSERT INTO catalog.wd14_results(blob_id,tags,model_id,model_revision) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, r.PathValue("id"), in.Tags, in.Model, in.Revision)
	if err == nil {
		_, err = tx.Exec(r.Context(), applyWD14Tags, r.PathValue("id"))
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	w.WriteHeader(204)
}

// Asset tags include both manually entered and automatically assigned labels.
func validAssetTags(tags []string) bool {
	if len(tags) > 512 {
		return false
	}
	for _, tag := range tags {
		if len(tag) > 256 {
			return false
		}
	}
	return true
}
