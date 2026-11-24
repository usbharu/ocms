package catalog_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"ocms/internal/catalog"
)

// Run only against a disposable database initialized with all migrations.
func TestAssetAndLabelSortDatabase(t *testing.T) {
	dsn := os.Getenv("OCMS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("requires disposable OCMS_TEST_DATABASE_URL")
	}
	ctx := context.Background()
	db, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	var owner string
	if err := db.QueryRow(ctx, `INSERT INTO catalog.principals(oidc_issuer,oidc_subject) VALUES('sort-test',gen_random_uuid()::text) RETURNING id`).Scan(&owner); err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	defer func() {
		exec(`DELETE FROM catalog.asset_favorites WHERE asset_id=ANY($1::uuid[])`, ids)
		exec(`DELETE FROM catalog.asset_characters WHERE asset_id=ANY($1::uuid[])`, ids)
		exec(`DELETE FROM catalog.asset_originals WHERE asset_id=ANY($1::uuid[])`, ids)
		exec(`DELETE FROM catalog.assets WHERE id=ANY($1::uuid[])`, ids)
		exec(`DELETE FROM catalog.principals WHERE id=$1`, owner)
	}()
	newAsset := func(filename, tag, character string, created, updated time.Time) string {
		t.Helper()
		var id string
		if err := db.QueryRow(ctx, `INSERT INTO catalog.assets(owner_id,filename,mime_type,tags,status,created_at,updated_at) VALUES($1,$2,'image/png',ARRAY[$3],'ready',$4,$5) RETURNING id`, owner, filename, tag, created, updated).Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
		exec(`INSERT INTO catalog.asset_originals(asset_id,blob_id) VALUES($1,gen_random_uuid())`, id)
		exec(`INSERT INTO catalog.asset_characters(asset_id,name,position) VALUES($1,$2,0)`, id, character)
		return id
	}
	jan := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	feb := time.Date(2024, 2, 1, 0, 0, 0, 0, time.UTC)
	mar := time.Date(2024, 3, 1, 0, 0, 0, 0, time.UTC)
	oldest := newAsset("oldest.png", "old", "c-old", jan, mar)
	middle := newAsset("middle.png", "middle", "c-middle", feb, jan)
	newest := newAsset("newest.png", "new", "c-new", mar, feb)
	// Favorite registration order differs from every Asset date order.
	exec(`INSERT INTO catalog.asset_favorites(principal_id,asset_id,created_at) VALUES($1,$3,$5),($1,$2,$4),($1,$6,$7)`, owner, oldest, middle, time.Date(2024, 1, 2, 0, 0, 0, 0, time.UTC), time.Date(2024, 1, 3, 0, 0, 0, 0, time.UTC), newest, time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC))

	token := strings.Repeat("s", 32)
	t.Setenv("INTERNAL_TOKEN", token)
	server := httptest.NewServer((&catalog.Service{DB: db}).Handler())
	defer server.Close()
	call := func(path string, status int) []byte {
		t.Helper()
		req, _ := http.NewRequest("GET", server.URL+path, bytes.NewReader(nil))
		req.Header.Set("X-Service-Token", token)
		req.Header.Set("X-Principal", owner)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var out bytes.Buffer
		out.ReadFrom(res.Body)
		if res.StatusCode != status {
			t.Fatalf("GET %s: got %d want %d: %s", path, res.StatusCode, status, out.String())
		}
		return out.Bytes()
	}
	assetIDs := func(path string) []string {
		t.Helper()
		var out struct {
			Assets []catalog.Asset
		}
		if err := json.Unmarshal(call(path, 200), &out); err != nil {
			t.Fatal(err)
		}
		got := make([]string, 0, len(out.Assets))
		for _, asset := range out.Assets {
			got = append(got, asset.ID)
		}
		return got
	}
	equal := func(label string, got, want []string) {
		t.Helper()
		if len(got) != len(want) {
			t.Fatalf("%s: got %v, want %v", label, got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("%s: got %v, want %v", label, got, want)
			}
		}
	}
	equal("created desc", assetIDs("/api/v1/assets?sort=created_desc"), []string{newest, middle, oldest})
	equal("created asc", assetIDs("/api/v1/assets?sort=created_asc"), []string{oldest, middle, newest})
	equal("updated desc", assetIDs("/api/v1/assets?sort=updated_desc"), []string{oldest, newest, middle})
	equal("updated asc", assetIDs("/api/v1/assets?sort=updated_asc"), []string{middle, newest, oldest})
	equal("favorites default", assetIDs("/api/v1/assets?favorites=true"), []string{middle, oldest, newest})
	equal("favorites sorted", assetIDs("/api/v1/assets?favorites=true&sort=created_desc"), []string{newest, middle, oldest})
	call("/api/v1/assets?sort=invalid", 400)

	labels := func(key, path string) []string {
		t.Helper()
		raw := call(path, 200)
		var out map[string]json.RawMessage
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatal(err)
		}
		var items []struct {
			Name string `json:"name"`
		}
		if err := json.Unmarshal(out[key], &items); err != nil {
			t.Fatal(err)
		}
		got := make([]string, 0, len(items))
		for _, item := range items {
			got = append(got, item.Name)
		}
		return got
	}
	equal("tags added desc", labels("tags", "/api/v1/tags?sort=added_desc"), []string{"new", "middle", "old"})
	equal("tags added asc", labels("tags", "/api/v1/tags?sort=added_asc"), []string{"old", "middle", "new"})
	equal("characters added desc", labels("characters", "/api/v1/characters?sort=added_desc"), []string{"c-new", "c-middle", "c-old"})
	equal("characters added asc", labels("characters", "/api/v1/characters?sort=added_asc"), []string{"c-old", "c-middle", "c-new"})
	call("/api/v1/tags?sort=invalid", 400)
	call("/api/v1/characters?sort=invalid", 400)
}
