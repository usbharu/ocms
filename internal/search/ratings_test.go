package search

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ocms/internal/catalog"
)

func TestRatingsFilterAfterAuthorizationBeforeLimit(t *testing.T) {
	t.Setenv("INTERNAL_TOKEN", strings.Repeat("t", 32))
	blob := "blob"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/authorize-blobs" || r.Header.Get("X-Principal") != "reader" {
			t.Error("missing final authorization")
		}
		json.NewEncoder(w).Encode(map[string]any{"assets": []catalog.Asset{
			{ID: "a-restricted", Rating: "explicit", BlobID: &blob},
			{ID: "z-allowed", Rating: "general", BlobID: &blob},
		}})
	}))
	defer server.Close()
	s := &Service{Catalog: server.URL}
	for _, mode := range []string{"keyword", "semantic", "hybrid", "perceptual"} {
		for _, ratings := range [][]string{nil, {}, {"general"}, {"unrated"}} {
			t.Run(mode+strings.Join(ratings, ","), func(t *testing.T) {
				req := httptest.NewRequest("POST", "/api/v1/search", nil)
				req.Header.Set("X-Principal", "reader")
				w := httptest.NewRecorder()
				s.respond(w, req, query{Mode: mode, Limit: 1, Ratings: ratings}, map[string]candidate{blob: {blob: blob, content: "synthetic snippet", rank: 1}}, nil)
				var out struct{ Assets []result }
				if json.Unmarshal(w.Body.Bytes(), &out) != nil || w.Code != 200 {
					t.Fatal("invalid response")
				}
				expectedID := "a-restricted"
				if ratings != nil && len(ratings) == 1 && ratings[0] == "general" {
					expectedID = "z-allowed"
				}
				want := 1
				if ratings != nil && len(ratings) == 0 || len(ratings) == 1 && ratings[0] == "unrated" {
					want = 0
				}
				if len(out.Assets) != want || want == 1 && out.Assets[0].ID != expectedID {
					t.Fatalf("wrong filtered result: %s", w.Body.String())
				}
			})
		}
	}
}
