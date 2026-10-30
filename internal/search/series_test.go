package search

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ocms/internal/catalog"
	"ocms/internal/contracts"
)

func TestSeriesTitleAndBlobIdentity(t *testing.T) {
	for _, v := range []string{"comic_001.png", "Comic page002.jpg", "comic (003).webp"} {
		if seriesTitle(v) != "comic" {
			t.Fatalf("failed page normalization: %q", v)
		}
	}
	if titleSimilarity("漫画 01.png", "漫画 02.jpg") != 1 || titleSimilarity("001.png", "002.png") != 0 {
		t.Fatal("invalid title similarity")
	}
	a := catalog.Asset{BlobIDs: []string{"one", "two"}}
	blob := "two"
	if !sharedBlob(a, catalog.Asset{BlobID: &blob}) {
		t.Fatal("must compare every constituent blob")
	}
	cache := personalCache{Assets: []contracts.RecommendationInput{
		{ID: "favorite", Favorite: true, BlobIDs: []string{"one", "two"}},
		{ID: "duplicate", BlobID: &blob, Tags: []string{"tag"}, MIME: "image/png", Rating: "general"},
		{ID: "series", BlobIDs: []string{"three"}, Tags: []string{"tag"}, MIME: catalog.SeriesMIME, SeriesKind: "composite", Rating: "general"},
	}, RecommendationPool: contracts.RecommendationPool{Candidates: []contracts.RecommendationScore{{ID: "duplicate", Score: 1}, {ID: "series", Score: 1}}}}
	pool, _ := personalCandidates(cache, personalConditions{Kind: "series"})
	if len(pool) != 1 || pool[0].ID != "series" {
		t.Fatal("series filtering or constituent deduplication failed")
	}
}

func TestSeriesSuggestionsLimitAfterRanking(t *testing.T) {
	t.Setenv("INTERNAL_TOKEN", strings.Repeat("t", 32))
	for _, count := range []int{0, 19, 20, 21, 200} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			assets := []catalog.Asset{}
			for i := count; i > 0; i-- {
				asset := catalog.Asset{ID: fmt.Sprintf("%04d", i), Filename: "unrelated.png"}
				if i == 1 {
					asset.Filename = "comic 002.png"
				}
				assets = append(assets, asset)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/v1/assets/seed":
					json.NewEncoder(w).Encode(catalog.Asset{ID: "seed", Filename: "comic 001.png"})
				case "/internal/series-candidates":
					json.NewEncoder(w).Encode(map[string]any{"assets": assets})
				default:
					t.Errorf("unexpected catalog request: %s", r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer server.Close()
			req := httptest.NewRequest(http.MethodPost, "/api/v1/series/suggestions", strings.NewReader(`{"kind":"collection","member_ids":["seed"]}`))
			req.Header.Set("X-Service-Token", strings.Repeat("t", 32))
			req.Header.Set("X-Principal", "owner")
			w := httptest.NewRecorder()
			(&Service{Catalog: server.URL}).Handler().ServeHTTP(w, req)
			if w.Code != http.StatusOK {
				t.Fatalf("unexpected status: %d", w.Code)
			}
			var response struct {
				Assets []seriesSuggestion `json:"assets"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			if len(response.Assets) != min(count, 20) {
				t.Fatalf("returned %d candidates for %d inputs", len(response.Assets), count)
			}
			for i, asset := range response.Assets {
				if asset.ID != fmt.Sprintf("%04d", i+1) {
					t.Fatalf("ranking or tie order changed at position %d", i)
				}
			}
			if count > 0 && response.Assets[0].Score <= 0 {
				t.Fatal("highest-scoring candidate must be retained before applying the limit")
			}
		})
	}
}
