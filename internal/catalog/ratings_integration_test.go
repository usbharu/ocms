package catalog

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"ocms/internal/contracts"
)

// Run only against a disposable database initialized with all migrations.
func TestContentRatingsDatabase(t *testing.T) {
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
	var owner, other, blob string
	if err := db.QueryRow(ctx, `INSERT INTO catalog.principals(oidc_issuer,oidc_subject) VALUES('rating-test',gen_random_uuid()::text) RETURNING id`).Scan(&owner); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `INSERT INTO catalog.principals(oidc_issuer,oidc_subject) VALUES('rating-test',gen_random_uuid()::text) RETURNING id`).Scan(&other); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `SELECT gen_random_uuid()`).Scan(&blob); err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	defer func() {
		exec(`DELETE FROM catalog.grants WHERE asset_id=ANY($1::uuid[])`, ids)
		exec(`DELETE FROM catalog.asset_originals WHERE asset_id=ANY($1::uuid[])`, ids)
		exec(`DELETE FROM catalog.assets WHERE id=ANY($1::uuid[])`, ids)
		exec(`DELETE FROM catalog.principals WHERE id=ANY($1::uuid[])`, []string{owner, other})
		for _, table := range []string{"wd14_results", "wd14_character_results", "wd14_rating_results"} {
			exec(`DELETE FROM catalog.`+table+` WHERE blob_id=$1`, blob)
		}
	}()
	newAsset := func(principal string) string {
		t.Helper()
		var id string
		if err := db.QueryRow(ctx, `INSERT INTO catalog.assets(owner_id,filename,mime_type) VALUES($1,'rating fixture','image/png') RETURNING id`, principal).Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
		exec(`INSERT INTO catalog.asset_originals(asset_id,blob_id) VALUES($1,$2)`, id, blob)
		return id
	}
	a, b := newAsset(owner), newAsset(other)
	token := strings.Repeat("t", 32)
	t.Setenv("INTERNAL_TOKEN", token)
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Service-Token") != token {
			t.Error("missing internal authentication")
		}
		w.WriteHeader(204)
	}))
	defer worker.Close()
	t.Setenv("MEDIA_URL", worker.URL)
	service := (&Service{DB: db}).Handler()
	call := func(method, path, principal string, body any, status int) []byte {
		t.Helper()
		raw, _ := json.Marshal(body)
		req := httptest.NewRequest(method, path, bytes.NewReader(raw))
		req.Header.Set("X-Service-Token", token)
		req.Header.Set("X-Principal", principal)
		w := httptest.NewRecorder()
		service.ServeHTTP(w, req)
		if w.Code != status {
			t.Fatalf("%s: status %d want %d: %s", path, w.Code, status, w.Body.String())
		}
		return w.Body.Bytes()
	}
	rating := func(id, principal string) string {
		t.Helper()
		var a Asset
		if err := json.Unmarshal(call("GET", "/api/v1/assets/"+id, principal, nil, 200), &a); err != nil {
			t.Fatal(err)
		}
		return a.Rating
	}
	if rating(a, owner) != "unrated" {
		t.Fatal("new content not unclassified")
	}
	call("PATCH", "/api/v1/assets/"+a, owner, map[string]string{"rating": "general"}, 200)
	call("PATCH", "/api/v1/assets/"+b, owner, map[string]string{"rating": "general"}, 404)
	call("PATCH", "/api/v1/assets/"+a, owner, map[string]string{"rating": "invalid"}, 400)
	prediction := map[string]any{"rating": "explicit", "tags": []string{"auto-tag"}, "characters": []string{}, "model_id": contracts.TagModel, "model_revision": contracts.TagRevision}
	call("POST", "/internal/blobs/"+blob+"/tags", "", prediction, 204)
	if rating(a, owner) != "general" || rating(b, other) != "explicit" {
		t.Fatal("manual override or duplicate isolation lost")
	}
	call("PATCH", "/api/v1/assets/"+b, other, map[string]string{"rating": "sensitive"}, 200)
	call("POST", "/internal/blobs/"+blob+"/tags", "", prediction, 204)
	if rating(b, other) != "sensitive" {
		t.Fatal("retry overwrote manual rating")
	}
	c := newAsset(owner)
	call("POST", "/internal/blobs/"+blob+"/state", "", map[string]string{"status": "ready"}, 204)
	if rating(c, owner) != "explicit" {
		t.Fatal("cached inference not applied")
	}
	for _, tc := range []struct {
		filter string
		count  int
	}{{"general", 1}, {"explicit", 1}, {"sensitive", 0}, {"", 0}, {"general,explicit", 2}} {
		var out struct {
			Assets []Asset
			Total  int
		}
		raw := call("GET", "/api/v1/assets?ratings="+tc.filter+"&limit=1", owner, nil, 200)
		if err := json.Unmarshal(raw, &out); err != nil || out.Total != tc.count || len(out.Assets) != min(1, tc.count) {
			t.Fatalf("filter %q: %s", tc.filter, raw)
		}
	}
	call("GET", "/api/v1/assets?ratings=invalid", owner, nil, 400)
	var out struct{ Assets []Asset }
	json.Unmarshal(call("GET", "/api/v1/assets/"+a+"/duplicates?ratings=explicit", owner, nil, 200), &out)
	if len(out.Assets) != 1 || out.Assets[0].ID != c {
		t.Fatal("duplicate rating filter or ACL failed")
	}
	// Manual editing and first automatic application serialize on the Asset.
	exec(`UPDATE catalog.assets SET wd14_rated=false,rating_manual=false,rating='unrated' WHERE id=$1`, c)
	var wg sync.WaitGroup
	errors := make(chan error, 2)
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, err := db.Exec(ctx, `UPDATE catalog.assets SET rating='questionable',rating_manual=true WHERE id=$1`, c)
		errors <- err
	}()
	go func() { defer wg.Done(); errors <- (&Service{DB: db}).reconcileCharacters(ctx, blob) }()
	wg.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	if rating(c, owner) != "questionable" {
		t.Fatal("concurrent manual rating lost")
	}
	fmt.Println("verified rating persistence, overrides, cached duplicates, retry, ACL, filters and pagination")
}
