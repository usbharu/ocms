package catalog

import (
	"encoding/json"
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
		Rating     string   `json:"rating"`
		Tags       []string `json:"tags"`
		Characters []string `json:"characters"`
		Model      string   `json:"model_id"`
		Revision   string   `json:"model_revision"`
	}
	if !platform.Decode(w, r, &in) {
		return
	}
	if (in.Rating != "" && contracts.RatingLevel(in.Rating) < 0) || in.Model != contracts.TagModel || in.Revision != contracts.TagRevision || len(in.Tags) > 256 || len(in.Characters) > 256 || !validCharacters(in.Characters) {
		platform.Error(w, 400, "INVALID_REQUEST")
		return
	}
	for _, tag := range in.Tags {
		if strings.TrimSpace(tag) == "" || len(tag) > 256 {
			platform.Error(w, 400, "INVALID_REQUEST")
			return
		}
	}
	in.Tags = contracts.NormalizeTags(in.Tags)
	in.Characters = contracts.NormalizeTags(in.Characters)
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
	ids, err := lockCharacterAssets(r.Context(), tx, r.PathValue("id"))
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	_, err = tx.Exec(r.Context(), `INSERT INTO catalog.wd14_results(blob_id,tags,model_id,model_revision) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, r.PathValue("id"), in.Tags, in.Model, in.Revision)
	if err == nil {
		_, err = tx.Exec(r.Context(), applyWD14Tags, r.PathValue("id"))
	}
	if err == nil && in.Characters != nil {
		_, err = tx.Exec(r.Context(), `INSERT INTO catalog.wd14_character_results(blob_id,characters,model_id,model_revision) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, r.PathValue("id"), in.Characters, in.Model, in.Revision)
	}
	if err == nil {
		_, err = tx.Exec(r.Context(), applyWD14Characters, r.PathValue("id"), ids)
	}
	if err == nil && in.Rating != "" {
		_, err = tx.Exec(r.Context(), `INSERT INTO catalog.wd14_rating_results(blob_id,rating,model_id,model_revision) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, r.PathValue("id"), in.Rating, in.Model, in.Revision)
	}
	if err == nil {
		_, err = tx.Exec(r.Context(), applyWD14Rating, r.PathValue("id"), ids)
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

// Aggregate only authorized, live Assets, deduplicating labels within each Asset.
// Nodes and edges share a single database snapshot. Graph work is bounded to 60 tags.
func (s *Service) listTags(w http.ResponseWriter, r *http.Request) {
	s.listLabels(w, r, "tags", `CROSS JOIN LATERAL unnest(a.tags) t(name)`)
}

func (s *Service) listCharacters(w http.ResponseWriter, r *http.Request) {
	s.listLabels(w, r, "characters", `CROSS JOIN LATERAL unnest(a.characters) t(name)`)
}

// Tags and characters have no timestamp of their own. Order them by the
// newest (or oldest) Asset addition among the authorized assets that use them.
func labelOrder(sort string) (string, bool) {
	switch sort {
	case "", "count":
		return `asset_count DESC,name COLLATE "C"`, true
	case "added_desc":
		return `latest_at DESC,name COLLATE "C"`, true
	case "added_asc":
		return `earliest_at ASC,name COLLATE "C"`, true
	default:
		return "", false
	}
}

func (s *Service) listLabels(w http.ResponseWriter, r *http.Request, key, source string) {
	if !guard(w, r) {
		return
	}
	values := r.URL.Query()["sort"]
	if len(values) > 1 {
		platform.Error(w, 400, "INVALID_SORT")
		return
	}
	sort := ""
	if len(values) == 1 {
		sort = values[0]
	}
	order, valid := labelOrder(sort)
	if !valid {
		platform.Error(w, 400, "INVALID_SORT")
		return
	}
	var result json.RawMessage
	err := s.DB.QueryRow(r.Context(), `WITH visible AS MATERIALIZED (
 SELECT DISTINCT a.id::text AS id,t.name,a.created_at FROM catalog.display_assets a `+source+`
 WHERE `+displayed+` AND btrim(t.name)<>''
 ), counts AS MATERIALIZED (
 SELECT name,count(*) AS asset_count,min(created_at) AS earliest_at,max(created_at) AS latest_at
 FROM visible WHERE strpos(lower(name),lower($2))>0 GROUP BY name
 ), top_tags AS MATERIALIZED (
 SELECT * FROM counts ORDER BY asset_count DESC,name COLLATE "C" LIMIT 200
 ), graph_tags AS MATERIALIZED (
 SELECT * FROM top_tags ORDER BY asset_count DESC,name COLLATE "C" LIMIT 60
 ), graph_assets AS MATERIALIZED (
 SELECT v.* FROM visible v JOIN graph_tags t USING(name)
 ), links AS (
 SELECT a.name AS source,b.name AS target,count(*) AS asset_count
 FROM graph_assets a JOIN graph_assets b ON a.id=b.id AND a.name COLLATE "C" < b.name COLLATE "C"
 GROUP BY a.name,b.name
 ) SELECT json_build_object(
 '`+key+`',COALESCE((SELECT json_agg(json_build_object('name',t.name,'asset_count',t.asset_count) ORDER BY `+order+`) FROM top_tags t),'[]'::json),
 'total',(SELECT count(*) FROM counts),
 'links',COALESCE((SELECT json_agg(l ORDER BY source COLLATE "C",target COLLATE "C") FROM links l),'[]'::json)
 )`, user(r), r.URL.Query().Get("q")).Scan(&result)
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	platform.JSON(w, 200, result)
}
