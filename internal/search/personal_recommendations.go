package search

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	random "math/rand/v2"
	"net/http"
	"net/url"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"ocms/internal/catalog"
	"ocms/internal/contracts"
	"ocms/internal/platform"
)

const recommendationEngineVersion = "tfidf-v1"

type personalCache struct {
	contracts.RecommendationPool
	Assets []contracts.RecommendationInput `json:"assets"`
}

type personalConditions struct {
	Kind    string   `json:"kind"`
	Ratings []string `json:"ratings"`
}

func recommendationFeatures(tags, characters []string) []string {
	out := make([]string, 0, len(tags)+len(characters))
	for _, t := range tags {
		out = append(out, "tag:"+t)
	}
	for _, c := range characters {
		out = append(out, "character:"+c)
	}
	return out
}

// Weighted sampling without replacement. A caller-supplied RNG makes the rule
// reproducible in tests; production seeds each new session from crypto/rand.
func sampleRecommendations(pool []contracts.RecommendationScore, features map[string][]string, recent map[string]bool, next func() float64) []contracts.RecommendationScore {
	remaining := append([]contracts.RecommendationScore{}, pool...)
	out := []contracts.RecommendationScore{}
	similarity := map[string]float64{}
	for len(remaining) > 0 && len(out) < 200 {
		weights := make([]float64, len(remaining))
		sum := 0.0
		for i, c := range remaining {
			w := c.Score * c.Score * math.Max(0.1, 1-similarity[c.ID])
			if recent[c.ID] {
				w *= 0.25
			}
			weights[i] = w
			sum += w
		}
		if sum <= 0 {
			break
		}
		point := next() * sum
		chosen := len(remaining) - 1
		for i, w := range weights {
			point -= w
			if point < 0 {
				chosen = i
				break
			}
		}
		item := remaining[chosen]
		out = append(out, item)
		remaining = append(remaining[:chosen], remaining[chosen+1:]...)
		for _, c := range remaining {
			v, _ := overlap(features[item.ID], features[c.ID])
			similarity[c.ID] = math.Max(similarity[c.ID], v)
		}
	}
	return out
}

func personalCandidates(cache personalCache, conditions personalConditions) ([]contracts.RecommendationScore, map[string][]string) {
	favorites := map[string]bool{}
	for _, a := range cache.Assets {
		if a.Favorite && a.BlobID != nil {
			favorites[*a.BlobID] = true
		}
	}
	allowed := map[string]bool{}
	features := map[string][]string{}
	for _, a := range cache.Assets {
		kind := strings.Split(a.MIME, "/")[0]
		if kind != "image" && kind != "video" && kind != "audio" {
			kind = "document"
		}
		if a.Favorite || (a.BlobID != nil && favorites[*a.BlobID]) || (conditions.Kind != "all" && kind != conditions.Kind) || !contracts.MatchesRating(a.Rating, conditions.Ratings) {
			continue
		}
		allowed[a.ID] = true
		features[a.ID] = recommendationFeatures(a.Tags, a.Characters)
	}
	pool := []contracts.RecommendationScore{}
	seen := map[string]bool{}
	for _, c := range cache.Candidates {
		if allowed[c.ID] && !seen[c.ID] && c.Score > 0 && c.Score <= 1.000001 && !math.IsNaN(c.Score) && !math.IsInf(c.Score, 0) {
			pool = append(pool, c)
			seen[c.ID] = true
		}
	}
	return pool, features
}

func (s *Service) personalRecommendations(w http.ResponseWriter, r *http.Request) {
	var principalID pgtype.UUID
	principal := r.Header.Get("X-Principal")
	if principalID.Scan(principal) != nil || !principalID.Valid {
		platform.Error(w, 401, "AUTH_REQUIRED")
		return
	}
	ratings, err := contracts.ParseRatings(r.URL.Query())
	if err != nil {
		platform.Error(w, 400, "INVALID_RATING")
		return
	}
	if ratings != nil {
		sort.Strings(ratings)
	}
	kind := r.URL.Query().Get("kind")
	if kind == "" {
		kind = "all"
	}
	if kind != "all" && kind != "image" && kind != "video" && kind != "audio" && kind != "document" {
		platform.Error(w, 400, "INVALID_KIND")
		return
	}
	page := 1
	if value := r.URL.Query().Get("page"); value != "" {
		page, err = strconv.Atoi(value)
		if err != nil || page < 1 || page > 9 {
			platform.Error(w, 400, "INVALID_PAGE")
			return
		}
	}
	sessionID := r.URL.Query().Get("session_id")
	if sessionID != "" {
		var id pgtype.UUID
		if id.Scan(sessionID) != nil || !id.Valid {
			platform.Error(w, 400, "INVALID_SESSION")
			return
		}
	} else if page != 1 {
		platform.Error(w, 400, "SESSION_REQUIRED")
		return
	}
	conditions := personalConditions{Kind: kind, Ratings: ratings}
	conditionJSON, _ := json.Marshal(conditions)
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	ctx, end := platform.Span(ctx, "search.personal_recommendations")
	defer end()
	started := time.Now()
	defer platform.Duration(ctx, "media.search.duration", started)
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	defer tx.Rollback(ctx)
	// Serialize only this principal's session/cache/history updates, without queuing.
	var locked bool
	if err = tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(hashtextextended($1,0))`, principal).Scan(&locked); err != nil {
		platform.RespondError(w, err)
		return
	}
	if !locked {
		platform.Error(w, 503, "RECOMMENDATION_BUSY")
		return
	}
	fail := func(err error) { platform.RespondError(w, err) }
	var cache personalCache
	var fingerprint string
	var raw []byte
	cacheHit := false
	err = tx.QueryRow(ctx, `SELECT fingerprint,pool FROM search.recommendation_cache WHERE principal_id=$1 AND engine_version=$2 AND expires_at>now()`, principal, recommendationEngineVersion).Scan(&fingerprint, &raw)
	if err == nil {
		if err = json.Unmarshal(raw, &cache); err != nil {
			fail(err)
			return
		}
		cacheHit = true
	} else if !errors.Is(err, pgx.ErrNoRows) {
		fail(err)
		return
	}
	var data contracts.RecommendationDataset
	datasetURL := s.Catalog + "/internal/recommendation-dataset"
	if err = platform.Call(ctx, "GET", datasetURL+"?fingerprint="+url.QueryEscape(fingerprint), principal, nil, &data); err != nil {
		fail(err)
		return
	}
	cacheHit = cacheHit && data.Unchanged
	if !cacheHit {
		cache.Assets = data.Assets
		if cache.Assets == nil {
			cache.Assets = []contracts.RecommendationInput{}
		}
	}
	fingerprint = data.Fingerprint
	var ids []string
	var scores []float64
	status := "ready"
	if sessionID != "" {
		var savedFingerprint, engine string
		var savedConditions []byte
		err = tx.QueryRow(ctx, `SELECT fingerprint,engine_version,conditions,status,asset_ids::text[],scores FROM search.recommendation_sessions WHERE id=$1 AND principal_id=$2 AND expires_at>now()`, sessionID, principal).Scan(&savedFingerprint, &engine, &savedConditions, &status, &ids, &scores)
		if errors.Is(err, pgx.ErrNoRows) {
			platform.Error(w, 409, "RECOMMENDATION_SESSION_EXPIRED")
			return
		}
		if err != nil {
			fail(err)
			return
		}
		var saved personalConditions
		if json.Unmarshal(savedConditions, &saved) != nil || !reflect.DeepEqual(saved, conditions) || savedFingerprint != fingerprint || engine != recommendationEngineVersion {
			platform.Error(w, 409, "RECOMMENDATION_SESSION_STALE")
			return
		}
	} else {
		if !cacheHit {
			var response struct {
				contracts.RecommendationPool
				EngineVersion string `json:"engine_version"`
			}
			if err = platform.Call(ctx, "POST", os.Getenv("RECOMMENDATION_URL")+"/recommend", "", map[string]any{"assets": cache.Assets}, &response); err != nil {
				fail(err)
				return
			}
			if response.EngineVersion != recommendationEngineVersion || (response.Status != "ready" && response.Status != "insufficient_information") || len(response.Candidates) > 1000 {
				platform.Error(w, 503, "INVALID_RECOMMENDATION_RESPONSE")
				return
			}
			cache.RecommendationPool = response.RecommendationPool
			raw, err = json.Marshal(cache)
			if err != nil {
				fail(err)
				return
			}
			_, err = tx.Exec(ctx, `INSERT INTO search.recommendation_cache(principal_id,fingerprint,engine_version,pool,expires_at) VALUES($1,$2,$3,$4,now()+interval '24 hours') ON CONFLICT(principal_id) DO UPDATE SET fingerprint=excluded.fingerprint,engine_version=excluded.engine_version,pool=excluded.pool,expires_at=excluded.expires_at`, principal, fingerprint, recommendationEngineVersion, raw)
			if err != nil {
				fail(err)
				return
			}
		}
		status = cache.Status
		pool, features := personalCandidates(cache, conditions)
		history, err := tx.Query(ctx, `SELECT asset_ids::text[] FROM search.recommendation_history WHERE principal_id=$1 AND created_at>now()-interval '24 hours' ORDER BY created_at DESC,id DESC LIMIT 3`, principal)
		if err != nil {
			fail(err)
			return
		}
		recent := map[string]bool{}
		var previous []string
		for history.Next() {
			var items []string
			if err = history.Scan(&items); err != nil {
				history.Close()
				fail(err)
				return
			}
			if previous == nil {
				previous = items
			}
			for _, id := range items {
				recent[id] = true
			}
		}
		err = history.Err()
		history.Close()
		if err != nil {
			fail(err)
			return
		}
		var seed [16]byte
		if _, err = rand.Read(seed[:]); err != nil {
			fail(err)
			return
		}
		rng := random.New(random.NewPCG(binary.LittleEndian.Uint64(seed[:8]), binary.LittleEndian.Uint64(seed[8:])))
		ids = []string{}
		scores = []float64{}
		for attempt := 0; attempt < 3; attempt++ {
			drawn := sampleRecommendations(pool, features, recent, rng.Float64)
			ids = []string{}
			scores = []float64{}
			for _, c := range drawn {
				ids = append(ids, c.ID)
				scores = append(scores, c.Score)
			}
			if len(pool) < 24 || !reflect.DeepEqual(ids[:min(24, len(ids))], previous) {
				break
			}
		}
		err = tx.QueryRow(ctx, `INSERT INTO search.recommendation_sessions(principal_id,fingerprint,engine_version,conditions,status,asset_ids,scores) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id::text`, principal, fingerprint, recommendationEngineVersion, conditionJSON, status, ids, scores).Scan(&sessionID)
		if err != nil {
			fail(err)
			return
		}
		if len(ids) > 0 {
			_, err = tx.Exec(ctx, `INSERT INTO search.recommendation_history(principal_id,asset_ids) VALUES($1,$2)`, principal, ids[:min(24, len(ids))])
			if err != nil {
				fail(err)
				return
			}
		}
	}
	// Authorization is performed for each page even on a cached/resumed session.
	start := min((page-1)*24, len(ids))
	stop := min(start+24, len(ids))
	var authorized struct {
		Assets []catalog.Asset `json:"assets"`
	}
	if len(ids[start:stop]) > 0 {
		if err = platform.Call(ctx, "POST", s.Catalog+"/internal/authorize-blobs", principal, map[string]any{"asset_ids": ids[start:stop]}, &authorized); err != nil {
			fail(err)
			return
		}
	}
	byID := map[string]catalog.Asset{}
	for _, a := range authorized.Assets {
		byID[a.ID] = a
	}
	var check contracts.RecommendationDataset
	if err = platform.Call(ctx, "GET", datasetURL+"?fingerprint="+url.QueryEscape(fingerprint), principal, nil, &check); err != nil {
		fail(err)
		return
	}
	if !check.Unchanged || len(byID) != stop-start {
		platform.Error(w, 409, "RECOMMENDATION_SESSION_STALE")
		return
	}
	tags, chars := []string{}, []string{}
	for _, a := range cache.Assets {
		if a.Favorite {
			tags = append(tags, a.Tags...)
			chars = append(chars, a.Characters...)
		}
	}
	out := []recommendation{}
	for i := start; i < stop; i++ {
		a := byID[ids[i]]
		_, commonTags := overlap(tags, a.Tags)
		_, commonChars := overlap(chars, a.Characters)
		out = append(out, recommendation{result: result{Asset: a}, Score: 100 * scores[i], CommonTags: commonTags, CommonCharacters: commonChars})
	}
	// Bounded retention; no external janitor is needed. Other principals' rows are
	// cleaned on their next request, avoiding cross-user write locks here.
	for _, query := range []string{
		`DELETE FROM search.recommendation_sessions WHERE principal_id=$1 AND expires_at<=now()`,
		`DELETE FROM search.recommendation_history WHERE principal_id=$1 AND id NOT IN (SELECT id FROM search.recommendation_history WHERE principal_id=$1 AND created_at>now()-interval '24 hours' ORDER BY created_at DESC,id DESC LIMIT 3)`,
	} {
		if _, err = tx.Exec(ctx, query, principal); err != nil {
			fail(err)
			return
		}
	}
	if err = tx.Commit(ctx); err != nil {
		fail(err)
		return
	}
	slog.DebugContext(ctx, "recommendations.served", "cache_hit", cacheHit, "result_count", len(ids))
	platform.JSON(w, 200, map[string]any{"status": status, "session_id": sessionID, "assets": out, "total": len(ids), "page": page})
}
