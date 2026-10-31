package search

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"ocms/internal/catalog"
)

func TestAudioAlignmentAndSignedFingerprint(t *testing.T) {
	a := []int32{-12345678, 4211398, -98322114, 191991, 2928292, -191922, 3848176, 196388, 492228, 1923992}
	b := append([]int32{12, 34}, a...)
	if d := audioDistance(a, b); d != 0 {
		t.Fatalf("aligned fingerprint distance=%f", d)
	}
	opposite := make([]int32, len(a))
	for i, v := range a {
		opposite[i] = ^v
	}
	if d := audioDistance(a, opposite); d <= 0.25 {
		t.Fatalf("unrelated fingerprint accepted: %f", d)
	}
	if d := audioDistance(nil, a); d != 1 {
		t.Fatal("empty fingerprint matched")
	}
}
func TestRejectMalformedInferenceVector(t *testing.T) {
	if _, err := vectorString([]float64{1}); err == nil {
		t.Fatal("wrong dimension accepted")
	}
	v := make([]float64, 768)
	v[5] = math.NaN()
	if _, err := vectorString(v); err == nil {
		t.Fatal("NaN accepted")
	}
	v[5] = math.Inf(1)
	if _, err := vectorString(v); err == nil {
		t.Fatal("infinite component accepted")
	}
}

// The final Catalog authorization must receive the scope before the public limit
// and only authorized Assets may contribute snippets or favorite flags.
func TestFavoriteAndGroupScopeBeforeResultLimit(t *testing.T) {
	for _, mode := range []string{"keyword", "semantic", "hybrid", "perceptual"} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("INTERNAL_TOKEN", strings.Repeat("t", 32))
			catalogServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/internal/authorize-blobs" || r.Header.Get("X-Principal") != "alice" {
					t.Errorf("unexpected authorization request")
				}
				var in struct {
					GroupID   string   `json:"group_id"`
					Favorites bool     `json:"favorites"`
					BlobIDs   []string `json:"blob_ids"`
					AssetIDs  []string `json:"asset_ids"`
				}
				if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
					t.Error(err)
				}
				if in.GroupID != "default" || !in.Favorites || len(in.BlobIDs) != 2 || len(in.AssetIDs) != 2 {
					t.Errorf("scope or candidates lost: %+v", in)
				}
				blob := "favorite-blob"
				json.NewEncoder(w).Encode(map[string]any{"assets": []catalog.Asset{{ID: "favorite", BlobID: &blob, IsFavorite: true}}})
			}))
			defer catalogServer.Close()
			s := Service{Catalog: catalogServer.URL}
			req := httptest.NewRequest("POST", "/api/v1/search", nil)
			req.Header.Set("X-Principal", "alice")
			rec := httptest.NewRecorder()
			s.respond(rec, req, query{Mode: mode, Favorites: true, Limit: 1, GroupID: "default"}, map[string]candidate{
				"hidden-blob":   {blob: "hidden-blob", content: "private snippet", rank: 10},
				"favorite-blob": {blob: "favorite-blob", content: "visible snippet", rank: 1},
			}, []catalog.Asset{{ID: "hidden"}, {ID: "favorite"}})
			if rec.Code != 200 || strings.Contains(rec.Body.String(), "private") {
				t.Fatalf("response %d: %s", rec.Code, rec.Body.String())
			}
			var out struct {
				Assets []result `json:"assets"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
				t.Fatal(err)
			}
			if len(out.Assets) != 1 || out.Assets[0].ID != "favorite" || !out.Assets[0].IsFavorite {
				t.Fatalf("unexpected results: %+v", out)
			}
		})
	}
}

func TestSemanticSearchDisabled(t *testing.T) {
	for _, mode := range []string{"semantic", "hybrid"} {
		t.Run(mode, func(t *testing.T) {
			// A nil DB and no upstreams ensure rejection precedes all dependency I/O.
			s := Service{SemanticSearchDisabled: true}
			req := httptest.NewRequest("POST", "/api/v1/search", strings.NewReader(`{"query":"fixture","mode":"`+mode+`"}`))
			rec := httptest.NewRecorder()
			s.search(rec, req)
			if rec.Code != http.StatusServiceUnavailable || rec.Body.String() != "{\"error\":\"SEMANTIC_SEARCH_DISABLED\"}\n" {
				t.Fatalf("response %d: %s", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestSemanticSearchEnabledByDefault(t *testing.T) {
	t.Setenv("INTERNAL_TOKEN", strings.Repeat("t", 32))
	var called atomic.Bool
	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called.Store(true)
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer runtime.Close()
	s := Service{Runtime: runtime.URL}
	req := httptest.NewRequest("POST", "/api/v1/search", strings.NewReader(`{"query":"fixture","mode":"semantic"}`))
	rec := httptest.NewRecorder()
	s.search(rec, req)
	if !called.Load() || rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "EMBEDDING_UNAVAILABLE") {
		t.Fatalf("default search did not call Runtime: %d %s", rec.Code, rec.Body.String())
	}
}
