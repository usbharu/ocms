package search

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"ocms/internal/catalog"
	"ocms/internal/contracts"
	"ocms/internal/platform"
)

// Uses a disposable migrated PostgreSQL DB; optionally uses the actual Python
// engine via OCMS_TEST_RECOMMENDATION_URL. No development/user media is touched.
func TestPersonalRecommendationsDatabase(t *testing.T) {
	dsn := os.Getenv("OCMS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("requires disposable OCMS_TEST_DATABASE_URL")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := admin.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	roleDB := func(role string) *pgxpool.Pool {
		t.Helper()
		config, err := pgxpool.ParseConfig(dsn)
		if err != nil {
			t.Fatal(err)
		}
		config.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
			_, err := conn.Exec(ctx, "SET ROLE "+role)
			return err
		}
		db, err := pgxpool.NewWithConfig(ctx, config)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(db.Close)
		return db
	}
	catDB, searchDB := roleDB("catalog_app"), roleDB("search_app")
	principal := func() string {
		t.Helper()
		var id string
		if err := admin.QueryRow(ctx, `INSERT INTO catalog.principals(oidc_issuer,oidc_subject) VALUES('personal-recommendation-test',gen_random_uuid()::text) RETURNING id::text`).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	owner, other, blank := principal(), principal(), principal()
	ids := []string{}
	defer func() {
		for _, p := range []string{owner, other, blank} {
			for _, table := range []string{"recommendation_history", "recommendation_sessions", "recommendation_cache"} {
				exec(`DELETE FROM search.`+table+` WHERE principal_id=$1`, p)
			}
		}
		exec(`DELETE FROM catalog.grants WHERE asset_id=ANY($1::uuid[])`, ids)
		exec(`DELETE FROM catalog.asset_originals WHERE asset_id=ANY($1::uuid[])`, ids)
		exec(`DELETE FROM catalog.assets WHERE id=ANY($1::uuid[])`, ids)
		exec(`DELETE FROM catalog.principals WHERE id=ANY($1::uuid[])`, []string{owner, other, blank})
	}()
	makeAsset := func(principal string) string {
		t.Helper()
		var id string
		if err := admin.QueryRow(ctx, `INSERT INTO catalog.assets(owner_id,filename,mime_type,tags,rating) VALUES($1,'generated recommendation fixture','image/png',ARRAY['x'],'general') RETURNING id::text`, principal).Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
		return id
	}
	seed := makeAsset(owner)
	exec(`INSERT INTO catalog.asset_favorites(principal_id,asset_id) VALUES($1,$2)`, owner, seed)
	blob := "11111111-1111-4111-8111-111111111111"
	exec(`INSERT INTO catalog.asset_originals(asset_id,blob_id) VALUES($1,$2)`, seed, blob)
	duplicate := makeAsset(owner)
	exec(`INSERT INTO catalog.asset_originals(asset_id,blob_id) VALUES($1,$2)`, duplicate, blob)
	for i := 0; i < 35; i++ {
		makeAsset(owner)
	}
	shared, hidden := makeAsset(other), makeAsset(other)
	exec(`INSERT INTO catalog.grants(asset_id,principal_id,permission) VALUES($1,$2,'read')`, shared, owner)
	token := os.Getenv("INTERNAL_TOKEN")
	if len(token) < 32 {
		token = strings.Repeat("r", 32)
	}
	t.Setenv("INTERNAL_TOKEN", token)
	cat := httptest.NewServer((&catalog.Service{DB: catDB}).Handler())
	defer cat.Close()
	calls := 0
	broken := false
	engine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if broken {
			platform.Error(w, 503, "FAILED")
			return
		}
		if remote := os.Getenv("OCMS_TEST_RECOMMENDATION_URL"); remote != "" {
			var input any
			if json.NewDecoder(r.Body).Decode(&input) != nil {
				t.Error("engine input")
				return
			}
			var out any
			if err := platform.Call(r.Context(), "POST", remote+"/recommend", "", input, &out); err != nil {
				platform.RespondError(w, err)
				return
			}
			platform.JSON(w, 200, out)
			return
		}
		var input struct {
			Assets []contracts.RecommendationInput `json:"assets"`
		}
		if json.NewDecoder(r.Body).Decode(&input) != nil {
			t.Error("input")
			return
		}
		out := contracts.RecommendationPool{Status: "insufficient_information", Candidates: []contracts.RecommendationScore{}}
		for _, a := range input.Assets {
			if a.Favorite && len(a.Tags) > 0 {
				out.Status = "ready"
			}
		}
		if out.Status == "ready" {
			for _, a := range input.Assets {
				if len(a.Tags) > 0 {
					out.Candidates = append(out.Candidates, contracts.RecommendationScore{ID: a.ID, Score: 1})
				}
			}
		}
		platform.JSON(w, 200, map[string]any{"status": out.Status, "candidates": out.Candidates, "engine_version": recommendationEngineVersion})
	}))
	defer engine.Close()
	t.Setenv("RECOMMENDATION_URL", engine.URL)
	service := func() http.Handler { return (&Service{DB: searchDB, Catalog: cat.URL}).Handler() }
	handler := service()
	type response struct {
		Status  string           `json:"status"`
		Session string           `json:"session_id"`
		Assets  []recommendation `json:"assets"`
		Total   int              `json:"total"`
	}
	call := func(principal, path string, status int) response {
		t.Helper()
		r := httptest.NewRequest("GET", "/api/v1/recommendations"+path, nil)
		r.Header.Set("X-Service-Token", token)
		r.Header.Set("X-Principal", principal)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != status {
			t.Fatalf("recommendation status got %d want %d: %s", w.Code, status, w.Body.String())
		}
		var out response
		if status == 200 && json.Unmarshal(w.Body.Bytes(), &out) != nil {
			t.Fatal("invalid response")
		}
		if bytes.Contains(w.Body.Bytes(), []byte(`"blob_id":"`+blob+`"`)) {
			t.Fatal("favorite blob was recommended")
		}
		return out
	}
	started := time.Now()
	first := call(owner, "", 200)
	cold := time.Since(started)
	if first.Status != "ready" || first.Total != 36 || len(first.Assets) != 36 || calls != 1 {
		t.Fatalf("bad initial pool: total %d, page %d, engine %d", first.Total, len(first.Assets), calls)
	}
	seen := map[string]bool{}
	for _, a := range first.Assets {
		if a.ID == seed || a.ID == duplicate || a.ID == hidden {
			t.Fatal("exclusion failed")
		}
		seen[a.ID] = true
	}
	path := "?session_id=" + url.QueryEscape(first.Session)
	if !reflect.DeepEqual(first, call(owner, path, 200)) {
		t.Fatal("resumed page changed")
	}
	second := call(owner, path+"&page=2", 200)
	if len(second.Assets) != 0 {
		t.Fatal("page size")
	}
	for _, a := range second.Assets {
		if seen[a.ID] {
			t.Fatal("duplicate across pages")
		}
	}
	handler = service() // Simulated Search restart: cache/session live only in PostgreSQL.
	started = time.Now()
	fresh := call(owner, "", 200)
	warm := time.Since(started)
	if calls != 1 || fresh.Session == first.Session || reflect.DeepEqual(fresh.Assets, first.Assets) {
		t.Fatal("cache/restart/variation failed")
	}
	t.Logf("cold=%s cached=%s engine_calls=%d", cold, warm, calls)
	if call(blank, "", 200).Status != "insufficient_information" {
		t.Fatal("empty library must not fail engine validation")
	}
	call(other, path, 409)
	if call(other, "", 200).Status != "insufficient_information" {
		t.Fatal("cross-principal preferences")
	}
	before := calls
	if out := call(owner, "?ratings=", 200); out.Total != 0 || out.Status != "ready" || calls != before {
		t.Fatal("empty filter must preserve model/cache")
	}
	exec(`DELETE FROM catalog.grants WHERE asset_id=$1 AND principal_id=$2`, shared, owner)
	call(owner, path, 409)
	after := call(owner, "", 200)
	if after.Total != 35 || calls != before+1 {
		t.Fatal("ACL did not invalidate pool")
	}
	exec(`UPDATE search.recommendation_sessions SET expires_at=now()-interval '1 second' WHERE id=$1`, after.Session)
	call(owner, "?session_id="+after.Session, 409)
	exec(`UPDATE catalog.assets SET tags=ARRAY['x','y'] WHERE id=$1`, seed)
	call(owner, "", 200)
	if calls != before+2 {
		t.Fatal("tag edit failed to invalidate")
	}
	exec(`INSERT INTO catalog.asset_favorites(principal_id,asset_id) VALUES($1,$2)`, owner, ids[2])
	if out := call(owner, "", 200); out.Total != 34 {
		t.Fatal("favorite registration failed to invalidate")
	}
	exec(`DELETE FROM catalog.asset_favorites WHERE principal_id=$1 AND asset_id=$2`, owner, ids[2])
	if out := call(owner, "", 200); out.Total != 35 {
		t.Fatal("favorite removal failed to invalidate")
	}
	exec(`UPDATE catalog.assets SET deleted_at=now() WHERE id=$1`, ids[2])
	if out := call(owner, "", 200); out.Total != 34 {
		t.Fatal("deletion failed to invalidate")
	}
	exec(`UPDATE search.recommendation_cache SET expires_at=now()-interval '1 second' WHERE principal_id=$1`, owner)
	broken = true
	call(owner, "", 503)
	broken = false
	last := call(owner, "", 200)
	call(owner, "?session_id="+last.Session+"&kind=audio", 409)
	// A concurrent request must fail immediately, without disturbing history.
	lock, err := admin.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = lock.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, owner); err != nil {
		t.Fatal(err)
	}
	call(owner, "", 503)
	if err = lock.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	var historyCount int
	if err = admin.QueryRow(ctx, `SELECT count(*) FROM search.recommendation_history WHERE principal_id=$1`, owner).Scan(&historyCount); err != nil {
		t.Fatal(err)
	}
	if historyCount != 3 {
		t.Fatal("history must retain only the three latest generations")
	}
	// An engine version change is a cache miss, even with the same dataset.
	previousCalls := calls
	exec(`UPDATE search.recommendation_cache SET engine_version='obsolete' WHERE principal_id=$1`, owner)
	call(owner, "", 200)
	if calls != previousCalls+1 {
		t.Fatal("engine version must invalidate the cache")
	}
	exec(`UPDATE catalog.assets SET rating='explicit' WHERE id=$1`, ids[3])
	call(owner, "?session_id="+last.Session, 409)
	call(owner, "?kind=bad", 400)
	call(owner, "?page=2", 400)
	call(owner, "?session_id=bad", 400)
	cat.Close()
	call(owner, "", 503)
}
