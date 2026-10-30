package search

import (
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"ocms/internal/catalog"
	"ocms/internal/contracts"
	"ocms/internal/platform"
)

func assetBlobs(a catalog.Asset) []string {
	if len(a.BlobIDs) > 0 {
		return a.BlobIDs
	}
	if a.BlobID != nil {
		return []string{*a.BlobID}
	}
	return nil
}
func inputBlobs(a contracts.RecommendationInput) []string {
	if len(a.BlobIDs) > 0 {
		return a.BlobIDs
	}
	if a.BlobID != nil {
		return []string{*a.BlobID}
	}
	return nil
}
func sharedBlob(a, b catalog.Asset) bool {
	for _, x := range assetBlobs(a) {
		for _, y := range assetBlobs(b) {
			if x == y {
				return true
			}
		}
	}
	return false
}

var pageSuffix = regexp.MustCompile(`(?i)[\s_\-\(\[]*(?:page|p)?[0-9]+[\)\]]*$`)

func seriesTitle(s string) string {
	return strings.TrimSpace(pageSuffix.ReplaceAllString(strings.ToLower(strings.TrimSuffix(s, filepath.Ext(s))), ""))
}
func titleSimilarity(a, b string) float64 {
	a, b = seriesTitle(a), seriesTitle(b)
	if a == "" || b == "" {
		return 0
	}
	if a == b {
		return 1
	}
	grams := func(s string) []string {
		r := []rune(s)
		out := []string{}
		if len(r) == 1 {
			return []string{s}
		}
		for i := 0; i+1 < len(r); i++ {
			out = append(out, string(r[i:i+2]))
		}
		return out
	}
	v, _ := overlap(grams(a), grams(b))
	return v
}

type seriesSuggestion struct {
	catalog.Asset
	Score   float64  `json:"score"`
	Reasons []string `json:"reasons"`
}

func (s *Service) seriesSuggestions(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Kind      string   `json:"kind"`
		MemberIDs []string `json:"member_ids"`
		SourceID  string   `json:"source_id"`
		EditingID string   `json:"editing_id"`
		Query     string   `json:"query"`
	}
	if !platform.Decode(w, r, &in) {
		return
	}
	if len(in.MemberIDs) > 1500 {
		platform.Error(w, 400, "INVALID_REQUEST")
		return
	}
	principal := r.Header.Get("X-Principal")
	var candidates struct {
		Assets []catalog.Asset `json:"assets"`
	}
	seeds := []catalog.Asset{}
	for _, id := range in.MemberIDs {
		var a catalog.Asset
		if err := platform.Call(r.Context(), "GET", s.Catalog+"/api/v1/assets/"+url.PathEscape(id), principal, nil, &a); err != nil {
			platform.RespondError(w, err)
			return
		}
		seeds = append(seeds, a)
	}
	hashes := map[string]candidate{}
	if in.SourceID != "" {
		var source catalog.Asset
		if err := platform.Call(r.Context(), "GET", s.Catalog+"/api/v1/assets/"+url.PathEscape(in.SourceID), principal, nil, &source); err != nil {
			platform.RespondError(w, err)
			return
		}
		var err error
		hashes, _, err = s.recommendationHashes(r, source)
		if err != nil {
			platform.RespondError(w, err)
			return
		}
		seeds = append(seeds, source)
	}
	blobIDs := []string{}
	for blob := range hashes {
		blobIDs = append(blobIDs, blob)
	}
	payload := map[string]any{"kind": in.Kind, "member_ids": in.MemberIDs, "editing_id": in.EditingID, "query": in.Query, "blob_ids": blobIDs}
	if err := platform.Call(r.Context(), "POST", s.Catalog+"/internal/series-candidates", principal, payload, &candidates); err != nil {
		platform.RespondError(w, err)
		return
	}
	out := []seriesSuggestion{}
	for _, a := range candidates.Assets {
		title, tags, characters, visual := 0.0, 0.0, 0.0, 0.0
		for _, seed := range seeds {
			title = max(title, titleSimilarity(seed.Filename, a.Filename))
			v, _ := overlap(seed.Tags, a.Tags)
			tags = max(tags, v)
			v, _ = overlap(seed.Characters, a.Characters)
			characters = max(characters, v)
		}
		for _, blob := range assetBlobs(a) {
			visual = max(visual, hashes[blob].rank)
		}
		score := 0.4*title + 0.3*tags + 0.3*characters
		if in.SourceID != "" {
			score = 0.55*visual + 0.35*title + 0.05*tags + 0.05*characters
		}
		reasons := []string{}
		if title > 0 {
			reasons = append(reasons, "タイトルが近い")
		}
		if visual > 0 {
			reasons = append(reasons, "画像が似ている")
		}
		if tags > 0 {
			reasons = append(reasons, "共通のタグ")
		}
		if characters > 0 {
			reasons = append(reasons, "共通のキャラクター")
		}
		out = append(out, seriesSuggestion{a, score, reasons})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Score == out[j].Score {
			return out[i].ID < out[j].ID
		}
		return out[i].Score > out[j].Score
	})
	if len(out) > 20 {
		out = out[:20]
	}
	platform.JSON(w, 200, map[string]any{"assets": out})
}
