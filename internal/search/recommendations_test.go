package search

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"ocms/internal/catalog"
	"ocms/internal/contracts"
)

func TestOverlap(t *testing.T) {
	for _, tc := range []struct {
		a, b  []string
		score float64
		names int
	}{
		{nil, nil, 0, 0}, {[]string{"A"}, nil, 0, 0},
		{[]string{"A", "A", "B"}, []string{"A", "C", "C"}, 1.0 / 3, 1},
		{[]string{"A"}, []string{"a"}, 0, 0},
	} {
		s, n := overlap(tc.a, tc.b)
		if s != tc.score || len(n) != tc.names {
			t.Fatalf("overlap: %v %v", s, n)
		}
	}
}
func TestRecommendationRanking(t *testing.T) {
	sourceBlob, otherBlob := "source", "other"
	source := catalog.Asset{ID: "source", Tags: []string{"tag"}, Characters: []string{"character"}, BlobID: &sourceBlob}
	candidateAsset := catalog.Asset{ID: "b", Tags: source.Tags, Characters: source.Characters, BlobID: &otherBlob}
	sameContent := candidateAsset
	sameContent.ID = "duplicate"
	sameContent.BlobID = &sourceBlob
	noMetadata := candidateAsset
	noMetadata.ID = "hash-only"
	noMetadata.Tags = nil
	noMetadata.Characters = nil
	out := rankRecommendations(source, []catalog.Asset{source, sameContent, candidateAsset, candidateAsset, noMetadata, {ID: "zero"}}, map[string]candidate{otherBlob: {rank: 1 - 12.0/64}}, labelFrequency{})
	if len(out) != 2 || out[0].ID != "b" || math.Abs(out[0].Score-96.25) > 1e-10 || out[1].Score != 16.25 {
		t.Fatalf("ranking: %#v", out)
	}
	if out[0].Perceptual != "visual" || len(out[0].CommonTags) != 1 || len(out[1].CommonTags) != 0 {
		t.Fatal("per-asset reasons lost")
	}
	source.MIME = "audio/ogg"
	if rankRecommendations(source, []catalog.Asset{candidateAsset}, map[string]candidate{otherBlob: {rank: 0.75}}, labelFrequency{})[0].Perceptual != "audio" {
		t.Fatal("audio reason missing")
	}
	// Missing hash evidence never renormalizes the metadata score.
	if rankRecommendations(source, []catalog.Asset{candidateAsset}, nil, labelFrequency{})[0].Score != 80 {
		t.Fatal("weights renormalized")
	}
}
func TestRecommendationLimitAndTies(t *testing.T) {
	source := catalog.Asset{ID: "source", Tags: []string{"x"}}
	assets := []catalog.Asset{}
	for i := 1005; i > 0; i-- {
		assets = append(assets, catalog.Asset{ID: fmt.Sprintf("%04d", i), Tags: source.Tags})
	}
	out := rankRecommendations(source, assets, nil, labelFrequency{})
	if len(out) != 200 || out[0].ID != "0001" || out[199].ID != "0200" {
		t.Fatal("limit or stable ordering broken")
	}
}

func TestRecommendationsAuthorizationAndFailures(t *testing.T) {
	for _, scenario := range []string{"success", "source-denied", "metadata-failed", "authorization-failed", "source-revoked"} {
		t.Run(scenario, func(t *testing.T) {
			t.Setenv("INTERNAL_TOKEN", strings.Repeat("t", 32))
			sourceCalls, authCalls := 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("X-Principal") != "reader" {
					t.Error("principal missing")
				}
				switch {
				case strings.HasSuffix(r.URL.Path, "recommendation-dataset"):
					if scenario == "metadata-failed" {
						w.WriteHeader(503)
						return
					}
					json.NewEncoder(w).Encode(map[string]any{"assets": []map[string]any{{"asset_id": "allowed", "tags": []string{"tag"}}, {"asset_id": "denied", "tags": []string{"tag"}}}})
				case strings.HasSuffix(r.URL.Path, "authorize-blobs"):
					authCalls++
					if scenario == "authorization-failed" {
						w.WriteHeader(503)
						return
					}
					json.NewEncoder(w).Encode(map[string]any{"assets": []catalog.Asset{{ID: "allowed", Tags: []string{"tag"}}}})
				default:
					sourceCalls++
					if scenario == "source-denied" || scenario == "source-revoked" && sourceCalls == 2 {
						w.WriteHeader(404)
						return
					}
					json.NewEncoder(w).Encode(catalog.Asset{ID: "source", MIME: "text/plain", Tags: []string{"tag"}})
				}
			}))
			defer server.Close()
			req := httptest.NewRequest("GET", "/api/v1/assets/source/recommendations", nil)
			req.Header.Set("X-Service-Token", strings.Repeat("t", 32))
			req.Header.Set("X-Principal", "reader")
			w := httptest.NewRecorder()
			(&Service{Catalog: server.URL}).Handler().ServeHTTP(w, req)
			expected := 200
			if scenario == "source-denied" || scenario == "source-revoked" {
				expected = 404
			} else if scenario != "success" {
				expected = 503
			}
			if w.Code != expected {
				t.Fatalf("status %d, expected %d", w.Code, expected)
			}
			if scenario == "success" {
				var response struct {
					Assets     []recommendation `json:"assets"`
					HashStatus string           `json:"hash_status"`
				}
				if json.Unmarshal(w.Body.Bytes(), &response) != nil || len(response.Assets) != 1 || response.Assets[0].ID != "allowed" || response.HashStatus != "unsupported" || authCalls != 2 {
					t.Fatal("authorization or unsupported media broken")
				}
			} else if strings.Contains(w.Body.String(), "tag") {
				t.Fatal("error leaked metadata")
			}
		})
	}
}
func TestMissingHashAndDatabaseFailure(t *testing.T) {
	a := catalog.Asset{MIME: "image/png"}
	s := &Service{}
	request := httptest.NewRequest("GET", "/", nil)
	if hashes, state, err := s.recommendationHashes(request, a); err != nil || state != "pending" || len(hashes) != 0 {
		t.Fatal("unuploaded source should be pending")
	}
	pool, err := pgxpool.New(context.Background(), "postgres://unavailable@127.0.0.1:1/ocms?connect_timeout=1")
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	s.DB = pool
	blob := "00000000-0000-4000-8000-000000000001"
	a.BlobID = &blob
	for _, mime := range []string{"image/png", "audio/ogg"} {
		a.MIME = mime
		if _, _, err = s.recommendationHashes(request, a); err == nil {
			t.Fatal("DB failure treated as pending")
		}
	}
}

func TestRarityOverlap(t *testing.T) {
	f := frequencies([]contracts.RecommendationInput{
		{Tags: []string{"common", "rare", "rare"}, Characters: []string{"hero"}},
		{Tags: []string{"common"}}, {Tags: []string{"common"}}, {Tags: []string{"common"}},
	})
	common, _ := rarityOverlap([]string{"common", "rare"}, []string{"common"}, f.tags, f.total)
	rare, names := rarityOverlap([]string{"common", "rare"}, []string{"rare"}, f.tags, f.total)
	if common != 0.5 || math.Abs(rare-0.575) > 1e-10 || len(names) != 1 || f.tags["rare"] != 1 {
		t.Fatalf("common=%v rare=%v frequency=%v", common, rare, f.tags)
	}
	full, _ := rarityOverlap([]string{"hero"}, []string{"hero"}, f.characters, f.total)
	if full != 1 {
		t.Fatal("score exceeded its bound")
	}
}

func TestRareMetadataRanksAhead(t *testing.T) {
	source := catalog.Asset{ID: "source", Tags: []string{"common", "rare"}, Characters: []string{"usual", "unusual"}}
	assets := []catalog.Asset{{ID: "common", Tags: []string{"common"}, Characters: []string{"usual"}}, {ID: "rare", Tags: []string{"rare"}, Characters: []string{"unusual"}}}
	freq := labelFrequency{total: 10, tags: map[string]int{"common": 10, "rare": 2}, characters: map[string]int{"usual": 10, "unusual": 2}}
	for _, ranked := range [][]recommendation{rankMetadataCandidates(source, assets, freq), rankRecommendations(source, assets, nil, freq)} {
		if len(ranked) != 2 || ranked[0].ID != "rare" || ranked[0].Score <= ranked[1].Score {
			t.Fatalf("rarity did not affect ranking: %#v", ranked)
		}
	}
}
