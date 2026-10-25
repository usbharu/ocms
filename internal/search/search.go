package search

import (
	"encoding/json"
	"fmt"
	"math"
	"math/bits"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"ocms/internal/catalog"
	"ocms/internal/contracts"
	"ocms/internal/platform"
)

type Service struct {
	SemanticSearchDisabled  bool
	DB                      *pgxpool.Pool
	Catalog, Media, Runtime string
}

func New(db *pgxpool.Pool) *Service {
	return &Service{DB: db, Catalog: os.Getenv("CATALOG_URL"), Media: os.Getenv("MEDIA_URL"), Runtime: os.Getenv("RUNTIME_URL")}
}
func (s *Service) Handler() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("POST /api/v1/search", s.search)
	m.HandleFunc("GET /api/v1/assets/{id}/similar", s.similar)
	m.HandleFunc("GET /api/v1/assets/{id}/recommendations", s.recommendations)
	m.HandleFunc("POST /internal/index", s.index)
	m.HandleFunc("POST /internal/embeddings", s.embeddings)
	m.HandleFunc("GET /internal/passages/{id}", s.passages)
	return platform.Internal(m)
}

type result struct {
	catalog.Asset
	Snippet string `json:"snippet,omitempty"`
	Page    *int   `json:"page_number,omitempty"`
	Start   *int64 `json:"start_ms,omitempty"`
	End     *int64 `json:"end_ms,omitempty"`
}
type candidate struct {
	blob, content string
	page          *int
	start, end    *int64
	rank          float64
}
type query struct {
	Favorites bool     `json:"favorites"`
	Query     string   `json:"query"`
	Mode      string   `json:"mode"`
	Limit     int      `json:"limit"`
	Types     []string `json:"media_types"`
	AssetID   string   `json:"asset_id,omitempty"`
	Ratings   []string `json:"ratings"`
}

func (s *Service) search(w http.ResponseWriter, r *http.Request) {
	var in query
	if !platform.Decode(w, r, &in) {
		return
	}
	for _, rating := range in.Ratings {
		if !contracts.ValidRating(rating) {
			platform.Error(w, 400, "INVALID_RATING")
			return
		}
	}
	if in.Limit <= 0 || in.Limit > 200 {
		in.Limit = 20
	}
	if len(in.Query) > 8192 {
		platform.Error(w, 400, "QUERY_TOO_LONG")
		return
	}
	if in.Mode == "perceptual" {
		s.perceptual(w, r, in.AssetID, in.Limit, in.Favorites, in.Ratings)
		return
	}
	if in.Mode != "keyword" && in.Mode != "semantic" && in.Mode != "hybrid" {
		platform.Error(w, 400, "SEARCH_MODE_UNSUPPORTED")
		return
	}
	if s.SemanticSearchDisabled && in.Mode != "keyword" {
		platform.Error(w, http.StatusServiceUnavailable, "SEMANTIC_SEARCH_DISABLED")
		return
	}
	spanName := "search.keyword"
	if in.Mode != "keyword" {
		spanName = "search.semantic"
	}
	ctx, end := platform.Span(r.Context(), spanName)
	defer end()
	r = r.WithContext(ctx)
	started := time.Now()
	defer platform.Duration(ctx, "media.search.duration", started)
	candidates := map[string]candidate{}
	direct := []catalog.Asset{}
	if in.Mode != "semantic" {
		var out struct {
			Assets []catalog.Asset `json:"assets"`
		}
		if err := platform.Call(r.Context(), "GET", s.Catalog+"/api/v1/assets?q="+url.QueryEscape(in.Query)+"&favorites="+strconv.FormatBool(in.Favorites)+ratingQuery(in.Ratings), r.Header.Get("X-Principal"), nil, &out); err != nil {
			platform.RespondError(w, err)
			return
		}
		direct = out.Assets
		rows, err := s.DB.Query(r.Context(), `SELECT blob_id,content,page_number,start_ms,end_ms FROM search.passages WHERE content &@~ $1 ORDER BY id LIMIT 1000`, in.Query)
		if err != nil {
			platform.RespondError(w, err)
			return
		}
		rank := 0
		for rows.Next() {
			var c candidate
			if err = rows.Scan(&c.blob, &c.content, &c.page, &c.start, &c.end); err != nil {
				break
			}
			c.rank = 1 / float64(61+rank)
			rank++
			if old, ok := candidates[c.blob]; ok {
				c.rank += old.rank
			}
			candidates[c.blob] = c
		}
		if err == nil {
			err = rows.Err()
		}
		rows.Close()
		if err != nil {
			platform.RespondError(w, err)
			return
		}
	}
	if in.Mode != "keyword" {
		var embedding contracts.Embedding
		if err := platform.Call(r.Context(), "POST", s.Runtime+"/encode", "", map[string]any{"kind": "text", "text": in.Query, "query": true}, &embedding); err != nil {
			platform.Error(w, 503, "EMBEDDING_UNAVAILABLE")
			return
		}
		vector, err := vectorString(embedding.Vector)
		if err != nil {
			platform.Error(w, 503, "EMBEDDING_INVALID")
			return
		}
		rows, err := s.DB.Query(r.Context(), `SELECT blob_id,page_number,start_ms,end_ms FROM search.embeddings WHERE model_id=$2 AND model_revision=$3 ORDER BY embedding <=> $1::vector LIMIT 1000`, vector, embedding.Model, embedding.Revision)
		if err != nil {
			platform.RespondError(w, err)
			return
		}
		seen := map[string]bool{}
		rank := 0
		for rows.Next() {
			var c candidate
			if err = rows.Scan(&c.blob, &c.page, &c.start, &c.end); err != nil {
				break
			}
			if seen[c.blob] {
				continue
			}
			seen[c.blob] = true
			c.rank = 1 / float64(61+rank)
			rank++
			if old, ok := candidates[c.blob]; ok {
				c.rank += old.rank
				if old.content != "" {
					c.content = old.content
					c.page = old.page
					c.start = old.start
					c.end = old.end
				}
			}
			candidates[c.blob] = c
		}
		if err == nil {
			err = rows.Err()
		}
		rows.Close()
		if err != nil {
			platform.RespondError(w, err)
			return
		}
	}
	s.respond(w, r, in, candidates, direct)
}
func (s *Service) respond(w http.ResponseWriter, r *http.Request, in query, candidates map[string]candidate, direct []catalog.Asset) {
	if len(candidates) > 1000 {
		ranked := make([]candidate, 0, len(candidates))
		for _, c := range candidates {
			ranked = append(ranked, c)
		}
		sort.Slice(ranked, func(i, j int) bool { return ranked[i].rank > ranked[j].rank })
		candidates = map[string]candidate{}
		for _, c := range ranked[:1000] {
			candidates[c.blob] = c
		}
	}
	ids := make([]string, 0, len(candidates))
	for id := range candidates {
		ids = append(ids, id)
	}
	directRanks := map[string]float64{}
	directIDs := []string{}
	for i, a := range direct {
		directRanks[a.ID] = 1 / float64(61+i)
		directIDs = append(directIDs, a.ID)
	}
	var authorized struct {
		Assets []catalog.Asset `json:"assets"`
	}
	// BatchAuthorize is the final authority, after candidate generation in every mode.
	if err := platform.Call(r.Context(), "POST", s.Catalog+"/internal/authorize-blobs", r.Header.Get("X-Principal"), map[string]any{"blob_ids": ids, "asset_ids": directIDs, "favorites": in.Favorites}, &authorized); err != nil {
		platform.RespondError(w, err)
		return
	}
	out := []result{}
	seen := map[string]bool{}
	for _, a := range authorized.Assets {
		if !contracts.MatchesRating(a.Rating, in.Ratings) {
			continue
		}
		_, directMatch := directRanks[a.ID]
		contentMatch := false
		if a.BlobID != nil {
			_, contentMatch = candidates[*a.BlobID]
		}
		if !directMatch && !contentMatch {
			continue
		}
		if seen[a.ID] {
			continue
		}
		allowedType := len(in.Types) == 0
		for _, t := range in.Types {
			if strings.HasPrefix(a.MIME, t+"/") || t == "pdf" && a.MIME == "application/pdf" {
				allowedType = true
			}
		}
		if !allowedType {
			continue
		}
		seen[a.ID] = true
		item := result{Asset: a}
		if a.BlobID != nil {
			c := candidates[*a.BlobID]
			text := []rune(c.content)
			item.Snippet = string(text[:min(200, len(text))])
			item.Page = c.page
			item.Start = c.start
			item.End = c.end
		}
		out = append(out, item)
	}
	sort.SliceStable(out, func(i, j int) bool {
		rank := func(a result) float64 {
			if a.BlobID == nil {
				return directRanks[a.ID]
			}
			return candidates[*a.BlobID].rank + directRanks[a.ID]
		}
		if rank(out[i]) == rank(out[j]) {
			return out[i].ID < out[j].ID
		}
		return rank(out[i]) > rank(out[j])
	})
	if len(out) > in.Limit {
		out = out[:in.Limit]
	}
	platform.Audit(r.Context(), "search.executed", r.Header.Get("X-Principal"), "")
	platform.JSON(w, 200, map[string]any{"mode": in.Mode, "assets": out})
}
func (s *Service) similar(w http.ResponseWriter, r *http.Request) {
	ratings, err := contracts.ParseRatings(r.URL.Query())
	if err != nil {
		platform.Error(w, 400, "INVALID_RATING")
		return
	}
	favorites := r.URL.Query().Get("favorites")
	if favorites != "" && favorites != "true" && favorites != "false" {
		platform.Error(w, 400, "INVALID_FAVORITES")
		return
	}
	s.perceptual(w, r, r.PathValue("id"), 20, favorites == "true", ratings)
}
func (s *Service) perceptual(w http.ResponseWriter, r *http.Request, assetID string, limit int, favorites bool, ratings []string) {
	var a catalog.Asset
	if assetID == "" {
		platform.Error(w, 400, "ASSET_REQUIRED")
		return
	}
	if err := platform.Call(r.Context(), "GET", s.Catalog+"/api/v1/assets/"+url.PathEscape(assetID), r.Header.Get("X-Principal"), nil, &a); err != nil {
		platform.RespondError(w, err)
		return
	}
	if a.BlobID == nil {
		platform.Error(w, 409, "INDEX_PENDING")
		return
	}
	candidates := map[string]candidate{}
	if strings.HasPrefix(a.MIME, "audio/") {
		var reference []int32
		if err := s.DB.QueryRow(r.Context(), `SELECT fingerprint FROM search.audio_fingerprints WHERE blob_id=$1`, *a.BlobID).Scan(&reference); err != nil {
			platform.Error(w, 409, "INDEX_PENDING")
			return
		}
		rows, err := s.DB.Query(r.Context(), `SELECT blob_id,fingerprint FROM search.audio_fingerprints WHERE blob_id<>$1`, *a.BlobID)
		if err != nil {
			platform.RespondError(w, err)
			return
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			var fp []int32
			if err = rows.Scan(&id, &fp); err != nil {
				platform.RespondError(w, err)
				return
			}
			distance := audioDistance(reference, fp)
			if distance <= 0.25 {
				candidates[id] = candidate{blob: id, rank: 1 - distance}
			}
		}
		if rows.Err() != nil {
			platform.RespondError(w, rows.Err())
			return
		}
	} else {
		rows, err := s.DB.Query(r.Context(), `SELECT b.blob_id,min(a.phash <~> b.phash),min(b.page_number),min(b.frame_ms),count(DISTINCT a.ordinal),count(DISTINCT b.ordinal) FROM search.perceptual_hashes a JOIN search.perceptual_hashes b ON a.blob_id<>b.blob_id AND (a.phash <~> b.phash)<=12 WHERE a.blob_id=$1 GROUP BY b.blob_id ORDER BY min(a.phash <~> b.phash) LIMIT 1000`, *a.BlobID)
		if err != nil {
			platform.RespondError(w, err)
			return
		}
		defer rows.Close()
		for rows.Next() {
			var c candidate
			var distance float64
			var left, right int
			if err = rows.Scan(&c.blob, &distance, &c.page, &c.start, &left, &right); err != nil {
				platform.RespondError(w, err)
				return
			}
			c.rank = 1 / (1 + distance)
			candidates[c.blob] = c
		}
		if rows.Err() != nil {
			platform.RespondError(w, rows.Err())
			return
		}
	}
	s.respond(w, r, query{Mode: "perceptual", Limit: limit, Favorites: favorites, Ratings: ratings}, candidates, nil)
}
func audioDistance(a, b []int32) float64 {
	best := 1.0
	for shift := -8; shift <= 8; shift++ {
		sum, n := 0, 0
		for i, x := range a {
			j := i + shift
			if j < 0 || j >= len(b) {
				continue
			}
			sum += bits.OnesCount32(uint32(x) ^ uint32(b[j]))
			n++
		}
		if n >= min(8, min(len(a), len(b))) && n > 0 {
			distance := float64(sum) / float64(n*32)
			if distance < best {
				best = distance
			}
		}
	}
	return best
}
func vectorString(vector []float64) (string, error) {
	if len(vector) != 768 {
		return "", fmt.Errorf("dimension mismatch")
	}
	for _, v := range vector {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return "", fmt.Errorf("nonfinite vector")
		}
	}
	data, err := json.Marshal(vector)
	return string(data), err
}
func (s *Service) authorizeJob(w http.ResponseWriter, r *http.Request, blob string) bool {
	err := platform.Call(r.Context(), "POST", s.Media+"/internal/jobs/"+r.Header.Get("X-Job-ID")+"/authorize", "", map[string]string{"blob_id": blob, "lease_token": r.Header.Get("X-Job-Lease")}, nil)
	if err != nil {
		platform.Error(w, 403, "JOB_FORBIDDEN")
		return false
	}
	return true
}
func (s *Service) passages(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeJob(w, r, r.PathValue("id")) {
		return
	}
	rows, err := s.DB.Query(r.Context(), `SELECT kind,ordinal,page_number,start_ms,end_ms,content FROM search.passages WHERE blob_id::text=$1 ORDER BY kind,ordinal`, r.PathValue("id"))
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	defer rows.Close()
	out := []contracts.Passage{}
	for rows.Next() {
		var p contracts.Passage
		if err = rows.Scan(&p.Kind, &p.Ordinal, &p.Page, &p.Start, &p.End, &p.Content); err != nil {
			platform.RespondError(w, err)
			return
		}
		out = append(out, p)
	}
	if rows.Err() != nil {
		platform.RespondError(w, rows.Err())
		return
	}
	platform.JSON(w, 200, map[string]any{"passages": out})
}

// internal Decode permits bounded OCR text and batches of embeddings, larger than public JSON.
func decodeIndex(w http.ResponseWriter, r *http.Request) (contracts.Index, bool) {
	var in contracts.Index
	r.Body = http.MaxBytesReader(w, r.Body, 16<<20)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(&in); err != nil {
		platform.Error(w, 400, "INVALID_INDEX")
		return in, false
	}
	return in, true
}
func (s *Service) index(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeIndex(w, r)
	if !ok || !s.authorizeJob(w, r, in.BlobID) {
		return
	}
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	_, err = tx.Exec(r.Context(), `DELETE FROM search.passages WHERE blob_id=$1`, in.BlobID)
	if err == nil {
		_, err = tx.Exec(r.Context(), `DELETE FROM search.perceptual_hashes WHERE blob_id=$1`, in.BlobID)
	}
	if err == nil {
		_, err = tx.Exec(r.Context(), `DELETE FROM search.audio_fingerprints WHERE blob_id=$1`, in.BlobID)
	}
	for _, p := range in.Passages {
		if err != nil {
			break
		}
		_, err = tx.Exec(r.Context(), `INSERT INTO search.passages(blob_id,kind,ordinal,page_number,start_ms,end_ms,content) VALUES($1,$2,$3,$4,$5,$6,$7)`, in.BlobID, p.Kind, p.Ordinal, p.Page, p.Start, p.End, p.Content)
	}
	for _, h := range in.Hashes {
		if err != nil {
			break
		}
		_, err = tx.Exec(r.Context(), `INSERT INTO search.perceptual_hashes(blob_id,kind,ordinal,page_number,frame_ms,phash) VALUES($1,$2,$3,$4,$5,$6::bit(64))`, in.BlobID, h.Kind, h.Ordinal, h.Page, h.Frame, h.Hash)
	}
	if err == nil && len(in.Fingerprint) > 0 {
		_, err = tx.Exec(r.Context(), `INSERT INTO search.audio_fingerprints(blob_id,duration_ms,fingerprint) VALUES($1,$2,$3)`, in.BlobID, in.Duration, in.Fingerprint)
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
func (s *Service) embeddings(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeIndex(w, r)
	if !ok || !s.authorizeJob(w, r, in.BlobID) {
		return
	}
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	_, err = tx.Exec(r.Context(), `DELETE FROM search.embeddings WHERE blob_id=$1`, in.BlobID)
	for _, e := range in.Embeddings {
		if err != nil {
			break
		}
		vector, e2 := vectorString(e.Vector)
		if e2 != nil {
			platform.Error(w, 400, "INVALID_EMBEDDING")
			return
		}
		_, err = tx.Exec(r.Context(), `INSERT INTO search.embeddings(blob_id,source_type,ordinal,page_number,start_ms,end_ms,model_id,model_revision,embedding) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::vector)`, in.BlobID, e.Source, e.Ordinal, e.Page, e.Start, e.End, e.Model, e.Revision, vector)
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

func ratingQuery(ratings []string) string {
	if ratings == nil {
		return ""
	}
	return "&ratings=" + url.QueryEscape(strings.Join(ratings, ","))
}
