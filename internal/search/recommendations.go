package search

import (
	"errors"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"ocms/internal/catalog"
	"ocms/internal/platform"
)

type recommendation struct {
	result
	Score            float64  `json:"score"`
	CommonTags       []string `json:"common_tags"`
	CommonCharacters []string `json:"common_characters"`
	Perceptual       string   `json:"perceptual,omitempty"`
}

func overlap(a, b []string) (float64, []string) {
	left, union := map[string]bool{}, map[string]bool{}
	for _, v := range a {
		left[v] = true
		union[v] = true
	}
	common := map[string]bool{}
	for _, v := range b {
		union[v] = true
		if left[v] {
			common[v] = true
		}
	}
	names := make([]string, 0, len(common))
	for v := range common {
		names = append(names, v)
	}
	sort.Strings(names)
	if len(union) == 0 {
		return 0, names
	}
	return float64(len(common)) / float64(len(union)), names
}

func rankRecommendations(source catalog.Asset, assets []catalog.Asset, hashes map[string]candidate) []recommendation {
	out := []recommendation{}
	seen := map[string]bool{}
	for _, a := range assets {
		if seen[a.ID] || a.ID == source.ID || (source.BlobID != nil && a.BlobID != nil && *source.BlobID == *a.BlobID) {
			continue
		}
		seen[a.ID] = true
		c, chars := overlap(source.Characters, a.Characters)
		t, tags := overlap(source.Tags, a.Tags)
		item := recommendation{result: result{Asset: a}, CommonTags: tags, CommonCharacters: chars}
		h := 0.0
		if a.BlobID != nil {
			if match, ok := hashes[*a.BlobID]; ok {
				h = match.rank
				item.Page, item.Start, item.End = match.page, match.start, match.end
				item.Perceptual = "visual"
				if strings.HasPrefix(source.MIME, "audio/") {
					item.Perceptual = "audio"
				}
			}
		}
		item.Score = 100 * (0.5*c + 0.3*t + 0.2*h)
		if item.Score > 0 {
			out = append(out, item)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Score == out[j].Score {
			return out[i].ID < out[j].ID
		}
		return out[i].Score > out[j].Score
	})
	if len(out) > 200 {
		out = out[:200]
	}
	return out
}

func (s *Service) recommendations(w http.ResponseWriter, r *http.Request) {
	ctx, end := platform.Span(r.Context(), "search.recommendations")
	defer end()
	r = r.WithContext(ctx)
	started := time.Now()
	defer platform.Duration(ctx, "media.search.duration", started)
	principal := r.Header.Get("X-Principal")
	sourceURL := s.Catalog + "/api/v1/assets/" + url.PathEscape(r.PathValue("id"))
	var source catalog.Asset
	if err := platform.Call(ctx, "GET", sourceURL, principal, nil, &source); err != nil {
		platform.RespondError(w, err)
		return
	}
	var metadata struct {
		IDs []string `json:"asset_ids"`
	}
	if err := platform.Call(ctx, "GET", s.Catalog+"/internal/assets/"+url.PathEscape(source.ID)+"/recommendation-candidates", principal, nil, &metadata); err != nil {
		platform.RespondError(w, err)
		return
	}
	hashes, state, err := s.recommendationHashes(r, source)
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	blobs := make([]string, 0, len(hashes))
	for id := range hashes {
		blobs = append(blobs, id)
	}
	assets := []catalog.Asset{}
	// Each authorization call stays below Catalog's 1,500 identifier limit.
	for _, input := range []map[string]any{{"asset_ids": metadata.IDs}, {"blob_ids": blobs}} {
		var authorized struct {
			Assets []catalog.Asset `json:"assets"`
		}
		if err = platform.Call(ctx, "POST", s.Catalog+"/internal/authorize-blobs", principal, input, &authorized); err != nil {
			platform.RespondError(w, err)
			return
		}
		assets = append(assets, authorized.Assets...)
	}
	// Do not return recommendations if access to the source was revoked meanwhile.
	if err = platform.Call(ctx, "GET", sourceURL, principal, nil, &source); err != nil {
		platform.RespondError(w, err)
		return
	}
	platform.Audit(ctx, "search.executed", principal, "")
	platform.JSON(w, 200, map[string]any{"source_asset_id": source.ID, "hash_status": state, "assets": rankRecommendations(source, assets, hashes)})
}

func (s *Service) recommendationHashes(r *http.Request, a catalog.Asset) (map[string]candidate, string, error) {
	out := map[string]candidate{}
	audio := strings.HasPrefix(a.MIME, "audio/")
	if !audio && !strings.HasPrefix(a.MIME, "image/") && !strings.HasPrefix(a.MIME, "video/") && a.MIME != "application/pdf" {
		return out, "unsupported", nil
	}
	if a.BlobID == nil {
		return out, "pending", nil
	}
	if audio {
		var reference []int32
		err := s.DB.QueryRow(r.Context(), `SELECT fingerprint FROM search.audio_fingerprints WHERE blob_id=$1`, *a.BlobID).Scan(&reference)
		if errors.Is(err, pgx.ErrNoRows) {
			return out, "pending", nil
		}
		if err != nil {
			return nil, "", err
		}
		rows, err := s.DB.Query(r.Context(), `SELECT blob_id,fingerprint FROM search.audio_fingerprints WHERE blob_id<>$1`, *a.BlobID)
		if err != nil {
			return nil, "", err
		}
		defer rows.Close()
		matches := []candidate{}
		for rows.Next() {
			var id string
			var fp []int32
			if err = rows.Scan(&id, &fp); err != nil {
				return nil, "", err
			}
			if d := audioDistance(reference, fp); d <= 0.25 {
				matches = append(matches, candidate{blob: id, rank: 1 - d})
			}
		}
		if rows.Err() != nil {
			return nil, "", rows.Err()
		}
		sort.Slice(matches, func(i, j int) bool {
			if matches[i].rank == matches[j].rank {
				return matches[i].blob < matches[j].blob
			}
			return matches[i].rank > matches[j].rank
		})
		for _, c := range matches[:min(1000, len(matches))] {
			out[c.blob] = c
		}
	} else {
		var ready bool
		if err := s.DB.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM search.perceptual_hashes WHERE blob_id=$1)`, *a.BlobID).Scan(&ready); err != nil {
			return nil, "", err
		}
		if !ready {
			return out, "pending", nil
		}
		// Keep page/time from the actual closest pair rather than independent minima.
		rows, err := s.DB.Query(r.Context(), `SELECT blob_id,distance,page_number,frame_ms FROM (
   SELECT DISTINCT ON (b.blob_id) b.blob_id,(a.phash <~> b.phash) AS distance,b.page_number,b.frame_ms
   FROM search.perceptual_hashes a JOIN search.perceptual_hashes b ON a.blob_id<>b.blob_id AND (a.phash <~> b.phash)<=12
   WHERE a.blob_id=$1 ORDER BY b.blob_id,distance,b.ordinal,a.ordinal
  ) matches ORDER BY distance,blob_id LIMIT 1000`, *a.BlobID)
		if err != nil {
			return nil, "", err
		}
		defer rows.Close()
		for rows.Next() {
			var c candidate
			var distance float64
			if err = rows.Scan(&c.blob, &distance, &c.page, &c.start); err != nil {
				return nil, "", err
			}
			c.rank = 1 - distance/64
			out[c.blob] = c
		}
		if rows.Err() != nil {
			return nil, "", rows.Err()
		}
	}
	return out, "ready", nil
}
