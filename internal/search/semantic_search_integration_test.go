package search

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"ocms/internal/catalog"
)

func TestKeywordSearchWithSemanticSearchDisabledDatabase(t *testing.T) {
	dsn := os.Getenv("OCMS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("requires disposable OCMS_TEST_DATABASE_URL")
	}
	db, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	t.Setenv("INTERNAL_TOKEN", strings.Repeat("t", 32))
	catalogServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Principal") != "alice" {
			t.Error("principal missing")
		}
		switch r.URL.Path {
		case "/api/v1/assets":
			if r.URL.Query().Get("q") != "semanticflagfixture" {
				t.Error("keyword not forwarded")
			}
		case "/internal/authorize-blobs":
			var in struct {
				AssetIDs []string `json:"asset_ids"`
			}
			if err := json.NewDecoder(r.Body).Decode(&in); err != nil || len(in.AssetIDs) != 1 || in.AssetIDs[0] != "visible" {
				t.Error("final authorization candidates lost")
			}
		default:
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{"assets": []catalog.Asset{{ID: "visible", Filename: "fixture"}}})
	}))
	defer catalogServer.Close()
	// No Runtime URL: keyword search must succeed without embedding inference.
	s := Service{DB: db, Catalog: catalogServer.URL, SemanticSearchDisabled: true}
	req := httptest.NewRequest("POST", "/api/v1/search", strings.NewReader(`{"query":"semanticflagfixture","mode":"keyword"}`))
	req.Header.Set("X-Principal", "alice")
	req.Header.Set("X-Service-Token", strings.Repeat("t", 32))
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	var out struct {
		Assets []result `json:"assets"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if rec.Code != http.StatusOK || len(out.Assets) != 1 || out.Assets[0].ID != "visible" {
		t.Fatalf("keyword search failed: %d %s", rec.Code, rec.Body.String())
	}
}
