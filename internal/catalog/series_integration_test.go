package catalog_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"ocms/internal/catalog"
	"ocms/internal/contracts"
	"ocms/internal/search"
)

func TestSeriesDatabase(t *testing.T) {
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
	exec := func(q string, args ...any) {
		t.Helper()
		if _, e := db.Exec(ctx, q, args...); e != nil {
			t.Fatal(e)
		}
	}
	var owner, other string
	if e := db.QueryRow(ctx, `INSERT INTO catalog.principals(oidc_issuer,oidc_subject) VALUES('series-test',gen_random_uuid()::text) RETURNING id`).Scan(&owner); e != nil {
		t.Fatal(e)
	}
	if e := db.QueryRow(ctx, `INSERT INTO catalog.principals(oidc_issuer,oidc_subject) VALUES('series-test',gen_random_uuid()::text) RETURNING id`).Scan(&other); e != nil {
		t.Fatal(e)
	}
	createdBlobs := []string{}
	defer func() {
		for _, table := range []string{"recommendation_cache", "recommendation_sessions", "recommendation_history"} {
			exec(`DELETE FROM search.`+table+` WHERE principal_id=ANY($1::uuid[])`, []string{owner, other})
		}
		for _, table := range []string{"passages", "embeddings", "perceptual_hashes"} {
			exec(`DELETE FROM search.`+table+` WHERE blob_id=ANY($1::uuid[])`, createdBlobs)
		}
		exec(`DELETE FROM catalog.series_members WHERE series_id IN (SELECT id FROM catalog.assets WHERE owner_id=$1)`, owner)
		exec(`DELETE FROM catalog.series WHERE asset_id IN (SELECT id FROM catalog.assets WHERE owner_id=$1)`, owner)
		exec(`DELETE FROM search.passages WHERE blob_id IN (SELECT blob_id FROM catalog.asset_originals WHERE asset_id IN(SELECT id FROM catalog.assets WHERE owner_id=$1))`, owner)
		exec(`DELETE FROM search.embeddings WHERE blob_id IN (SELECT blob_id FROM catalog.asset_originals WHERE asset_id IN(SELECT id FROM catalog.assets WHERE owner_id=$1))`, owner)
		exec(`DELETE FROM search.perceptual_hashes WHERE blob_id IN (SELECT blob_id FROM catalog.asset_originals WHERE asset_id IN(SELECT id FROM catalog.assets WHERE owner_id=$1))`, owner)
		exec(`DELETE FROM catalog.asset_originals WHERE asset_id IN(SELECT id FROM catalog.assets WHERE owner_id=$1)`, owner)
		exec(`DELETE FROM catalog.grants WHERE asset_id IN(SELECT id FROM catalog.assets WHERE owner_id=$1)`, owner)
		exec(`DELETE FROM catalog.asset_favorites WHERE asset_id IN(SELECT id FROM catalog.assets WHERE owner_id=$1)`, owner)
		exec(`DELETE FROM catalog.assets WHERE owner_id=$1`, owner)
		exec(`DELETE FROM catalog.principals WHERE id=ANY($1::uuid[])`, []string{owner, other})
	}()
	token := strings.Repeat("s", 32)
	t.Setenv("INTERNAL_TOKEN", token)
	cat := httptest.NewServer((&catalog.Service{DB: db}).Handler())
	defer cat.Close()
	vector := make([]float64, 768)
	vector[0] = 1
	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(contracts.Embedding{Model: "series-test", Revision: "1", Vector: vector})
	}))
	defer runtime.Close()
	srch := httptest.NewServer((&search.Service{DB: db, Catalog: cat.URL, Runtime: runtime.URL}).Handler())
	defer srch.Close()
	call := func(base, method, path, principal string, body any, status int) []byte {
		t.Helper()
		raw, _ := json.Marshal(body)
		req, _ := http.NewRequest(method, base+path, bytes.NewReader(raw))
		req.Header.Set("X-Service-Token", token)
		req.Header.Set("X-Principal", principal)
		res, e := http.DefaultClient.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		var b bytes.Buffer
		b.ReadFrom(res.Body)
		if res.StatusCode != status {
			t.Fatalf("%s %s: got %d want %d: %s", method, path, res.StatusCode, status, b.String())
		}
		return b.Bytes()
	}
	decode := func(raw []byte) catalog.Asset {
		t.Helper()
		var a catalog.Asset
		if e := json.Unmarshal(raw, &a); e != nil {
			t.Fatal(e)
		}
		return a
	}
	newAsset := func(name, mime, rating string) catalog.Asset {
		t.Helper()
		var id, blob string
		if e := db.QueryRow(ctx, `INSERT INTO catalog.assets(owner_id,filename,mime_type,rating,status,tags) VALUES($1,$2,$3,$4,'ready',ARRAY[$2]) RETURNING id`, owner, name, mime, rating).Scan(&id); e != nil {
			t.Fatal(e)
		}
		if e := db.QueryRow(ctx, `INSERT INTO catalog.asset_originals(asset_id,blob_id) VALUES($1,gen_random_uuid()) RETURNING blob_id`, id).Scan(&blob); e != nil {
			t.Fatal(e)
		}
		createdBlobs = append(createdBlobs, blob)
		exec(`INSERT INTO catalog.asset_characters(asset_id,name,position) VALUES($1,'shared-character',0)`, id)
		return decode(call(cat.URL, "GET", "/api/v1/assets/"+id, owner, nil, 200))
	}
	create := func(name, kind string, ids []string) catalog.Asset {
		return decode(call(cat.URL, "POST", "/api/v1/series", owner, map[string]any{"name": name, "kind": kind, "member_ids": ids}, 200))
	}
	a, b := newAsset("comic 001.png", "image/png", "general"), newAsset("comic 002.png", "image/png", "explicit")
	c := newAsset("separate", "video/mp4", "general")
	for _, ids := range [][]string{{a.ID}, {a.ID, a.ID}, {a.ID, c.ID}} {
		call(cat.URL, "POST", "/api/v1/series", owner, map[string]any{"name": "invalid", "kind": "composite", "member_ids": ids}, 400)
	}
	comp := create("comic", "composite", []string{a.ID, b.ID})
	if comp.Rating != "explicit" || len(comp.Tags) != 2 || len(comp.Characters) != 1 || comp.CoverAssetID != a.ID {
		t.Fatal("wrong aggregate metadata")
	}
	call(cat.URL, "GET", "/api/v1/series/"+comp.ID, other, nil, 404)
	call(cat.URL, "POST", "/api/v1/series", owner, map[string]any{"name": "duplicate", "kind": "composite", "member_ids": []string{a.ID, b.ID}}, 400)
	var list struct {
		Assets []catalog.Asset
		Total  int
	}
	json.Unmarshal(call(cat.URL, "GET", "/api/v1/assets", owner, nil, 200), &list)
	if list.Total != 2 {
		t.Fatalf("expected 2 logical works, got %d", list.Total)
	}
	json.Unmarshal(call(cat.URL, "GET", "/api/v1/assets?limit=1&offset=1", owner, nil, 200), &list)
	if list.Total != 2 || len(list.Assets) != 1 {
		t.Fatal("pagination did not use logical works")
	}
	var labels struct {
		Total      int
		Characters []struct {
			Name       string
			AssetCount int `json:"asset_count"`
		}
	}
	json.Unmarshal(call(cat.URL, "GET", "/api/v1/characters", owner, nil, 200), &labels)
	if len(labels.Characters) != 1 || labels.Characters[0].AssetCount != 2 {
		t.Fatal("character counts included constituent images")
	}
	json.Unmarshal(call(cat.URL, "GET", "/api/v1/tags", other, nil, 200), &labels)
	if labels.Total != 0 {
		t.Fatal("unauthorized label counts leaked")
	}

	json.Unmarshal(call(cat.URL, "GET", "/api/v1/assets?kind=image", owner, nil, 200), &list)
	if list.Total != 0 {
		t.Fatal("composite images appeared separately")
	}
	json.Unmarshal(call(cat.URL, "GET", "/api/v1/assets?kind=series&ratings=general", owner, nil, 200), &list)
	if list.Total != 0 {
		t.Fatal("rating filtered before aggregation")
	}
	json.Unmarshal(call(cat.URL, "POST", "/internal/authorize-blobs", owner, map[string]any{"blob_ids": []string{*a.BlobID, *b.BlobID}}, 200), &list)
	if len(list.Assets) != 1 || list.Assets[0].ID != comp.ID {
		t.Fatal("blob resolution did not collapse")
	}
	call(cat.URL, "PUT", "/api/v1/assets/"+a.ID+"/favorite", owner, nil, 204)
	if !decode(call(cat.URL, "GET", "/api/v1/assets/"+comp.ID, owner, nil, 200)).IsFavorite {
		t.Fatal("favorite not inherited")
	}
	call(cat.URL, "DELETE", "/api/v1/assets/"+comp.ID+"/favorite", owner, nil, 204)
	if decode(call(cat.URL, "GET", "/api/v1/assets/"+a.ID, owner, nil, 200)).IsFavorite {
		t.Fatal("favorite removal not propagated")
	}
	call(cat.URL, "PUT", "/api/v1/assets/"+comp.ID+"/favorite", owner, nil, 204)
	if !decode(call(cat.URL, "GET", "/api/v1/assets/"+b.ID, owner, nil, 200)).IsFavorite {
		t.Fatal("favorite registration not propagated")
	}
	call(cat.URL, "DELETE", "/api/v1/assets/"+a.ID+"/favorite", owner, nil, 204)
	call(cat.URL, "DELETE", "/api/v1/assets/"+b.ID+"/favorite", owner, nil, 204)
	if decode(call(cat.URL, "GET", "/api/v1/assets/"+comp.ID, owner, nil, 200)).IsFavorite {
		t.Fatal("composite retained a stale own favorite")
	}
	// Personalized learning sees the composite once and invalidates persisted sessions after edits.
	learned := make(chan []contracts.RecommendationInput, 4)
	engine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Assets []contracts.RecommendationInput `json:"assets"`
		}
		json.NewDecoder(r.Body).Decode(&in)
		learned <- in.Assets
		pool := contracts.RecommendationPool{Status: "ready"}
		for _, asset := range in.Assets {
			pool.Candidates = append(pool.Candidates, contracts.RecommendationScore{ID: asset.ID, Score: 0.8})
		}
		json.NewEncoder(w).Encode(struct {
			contracts.RecommendationPool
			EngineVersion string `json:"engine_version"`
		}{pool, "tfidf-v1"})
	}))
	defer engine.Close()
	t.Setenv("RECOMMENDATION_URL", engine.URL)
	call(cat.URL, "PUT", "/api/v1/assets/"+c.ID+"/favorite", owner, nil, 204)
	var personal struct {
		Assets    []catalog.Asset
		SessionID string `json:"session_id"`
	}
	json.Unmarshal(call(srch.URL, "GET", "/api/v1/recommendations?kind=series", owner, nil, 200), &personal)
	if len(personal.Assets) != 1 || personal.Assets[0].ID != comp.ID {
		t.Fatal("personal recommendations failed to use one composite")
	}
	for _, asset := range <-learned {
		if asset.ID == a.ID || asset.ID == b.ID {
			t.Fatal("personal engine learned constituent images separately")
		}
		if asset.ID == comp.ID && len(asset.BlobIDs) != 2 {
			t.Fatal("personal engine lost constituent blob identity")
		}
	}
	call(cat.URL, "PATCH", "/api/v1/assets/"+b.ID, owner, map[string]any{"rating": "sensitive", "tags": []string{"updated"}}, 200)
	call(srch.URL, "GET", "/api/v1/recommendations?kind=series&session_id="+personal.SessionID, owner, nil, 409)
	comp = decode(call(cat.URL, "GET", "/api/v1/assets/"+comp.ID, owner, nil, 200))
	if comp.Rating != "sensitive" {
		t.Fatal("aggregate was stale")
	}
	// Keyword metadata and perceptual hits share the same logical identity.
	json.Unmarshal(call(srch.URL, "POST", "/api/v1/search", owner, map[string]any{"mode": "keyword", "query": "updated", "limit": 200, "media_types": []string{"series"}}, 200), &list)
	if len(list.Assets) != 1 || list.Assets[0].ID != comp.ID {
		t.Fatal("keyword collapse failed")
	}
	exec(`INSERT INTO search.perceptual_hashes(blob_id,kind,ordinal,phash) VALUES($1,'image',0,B'0000000000000000000000000000000000000000000000000000000000000000'),($2,'image',0,B'0000000000000000000000000000000000000000000000000000000000000001')`, *a.BlobID, *b.BlobID)
	// Both indexed pages resolve before the visible limit; retain the best page identity.
	for _, asset := range []catalog.Asset{a, b} {
		exec(`INSERT INTO search.passages(blob_id,kind,ordinal,content) VALUES($1,'ocr',0,'seriesindexedfixture')`, *asset.BlobID)
		raw, _ := json.Marshal(vector)
		exec(`INSERT INTO search.embeddings(blob_id,source_type,ordinal,model_id,model_revision,embedding) VALUES($1,'image',0,'series-test','1',$2::vector)`, *asset.BlobID, string(raw))
	}
	for _, mode := range []string{"keyword", "semantic", "hybrid"} {
		json.Unmarshal(call(srch.URL, "POST", "/api/v1/search", owner, map[string]any{"mode": mode, "query": "seriesindexedfixture", "limit": 1}, 200), &list)
		if len(list.Assets) != 1 || list.Assets[0].ID != comp.ID || list.Assets[0].MatchedAssetID == "" {
			t.Fatalf("indexed %s collapse lost matched image", mode)
		}
		json.Unmarshal(call(srch.URL, "POST", "/api/v1/search", other, map[string]any{"mode": mode, "query": "seriesindexedfixture", "limit": 1}, 200), &list)
		if len(list.Assets) != 0 {
			t.Fatal("unauthorized indexed result leaked")
		}
	}
	visual := newAsset("comic source.png", "image/png", "general")
	exec(`INSERT INTO search.perceptual_hashes(blob_id,kind,ordinal,phash) VALUES($1,'image',0,B'0000000000000000000000000000000000000000000000000000000000000011')`, *visual.BlobID)
	json.Unmarshal(call(srch.URL, "GET", "/api/v1/assets/"+visual.ID+"/similar", owner, nil, 200), &list)
	if len(list.Assets) != 1 || list.Assets[0].ID != comp.ID {
		t.Fatal("perceptual collapse failed")
	}
	json.Unmarshal(call(srch.URL, "GET", "/api/v1/assets/"+visual.ID+"/recommendations", owner, nil, 200), &list)
	found := false
	for _, v := range list.Assets {
		if v.ID == a.ID || v.ID == b.ID {
			t.Fatal("recommendation leaked constituent")
		}
		if v.ID == comp.ID {
			found = true
		}
	}
	if !found {
		t.Fatal("composite missing in related recommendations")
	}
	var suggestions struct {
		Assets []struct {
			catalog.Asset
			Reasons []string
		}
	}
	json.Unmarshal(call(srch.URL, "POST", "/api/v1/series/suggestions", owner, map[string]any{"kind": "composite", "member_ids": []string{visual.ID}, "source_id": visual.ID}, 200), &suggestions)
	for _, v := range suggestions.Assets {
		if v.ID == a.ID || v.ID == b.ID {
			t.Fatal("already grouped image suggested")
		}
	}
	exec(`UPDATE catalog.asset_originals SET blob_id=$2 WHERE asset_id=$1`, visual.ID, *b.BlobID)
	json.Unmarshal(call(cat.URL, "GET", "/api/v1/assets/"+visual.ID+"/duplicates", owner, nil, 200), &list)
	if len(list.Assets) != 1 || list.Assets[0].ID != comp.ID {
		t.Fatal("exact duplicate collapse failed")
	}
	call(cat.URL, "POST", "/internal/assets/"+a.ID+"/grants", owner, map[string]any{"principal_id": other, "permission": "read"}, 409)
	call(cat.URL, "POST", "/internal/assets/"+comp.ID+"/grants", owner, map[string]any{"principal_id": other, "permission": "read"}, 204)
	call(cat.URL, "GET", "/api/v1/series/"+comp.ID, other, nil, 200)
	call(cat.URL, "POST", "/api/v1/series", owner, map[string]any{"name": "acl mismatch", "kind": "collection", "member_ids": []string{comp.ID, c.ID}}, 409)
	call(cat.URL, "POST", "/internal/assets/"+c.ID+"/grants", owner, map[string]any{"principal_id": other, "permission": "read"}, 204)
	collection := create("collection", "collection", []string{comp.ID, c.ID})
	call(cat.URL, "POST", "/api/v1/series", owner, map[string]any{"name": "nested collection", "kind": "collection", "member_ids": []string{collection.ID, c.ID}}, 400)
	// Two writers with the same version: exactly one may commit.
	statuses := make(chan int, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			raw, _ := json.Marshal(map[string]any{"name": "reordered", "kind": "collection", "member_ids": []string{c.ID, comp.ID}, "version": collection.SeriesVersion})
			req, _ := http.NewRequest("PATCH", cat.URL+"/api/v1/series/"+collection.ID, bytes.NewReader(raw))
			req.Header.Set("X-Service-Token", token)
			req.Header.Set("X-Principal", owner)
			res, e := http.DefaultClient.Do(req)
			if e != nil {
				statuses <- 0
				return
			}
			res.Body.Close()
			statuses <- res.StatusCode
		}()
	}
	wg.Wait()
	close(statuses)
	counts := map[int]int{}
	for code := range statuses {
		counts[code]++
	}
	if counts[200] != 1 || counts[409] != 1 {
		t.Fatalf("concurrent versions: %v", counts)
	}
	// Deleting a page dissolves a one-page composite, preserving parent order.
	call(cat.URL, "DELETE", "/api/v1/assets/"+b.ID, owner, nil, 204)
	call(cat.URL, "GET", "/api/v1/series/"+comp.ID, owner, nil, 404)
	var detail catalog.SeriesDetail
	json.Unmarshal(call(cat.URL, "GET", "/api/v1/series/"+collection.ID, owner, nil, 200), &detail)
	if len(detail.Members) != 2 || detail.Members[0].ID != c.ID || detail.Members[1].ID != a.ID {
		t.Fatal("dissolution lost collection order")
	}
	call(cat.URL, "DELETE", "/api/v1/series/"+collection.ID, owner, nil, 204)
	call(cat.URL, "GET", "/api/v1/assets/"+a.ID, owner, nil, 200) // Grouping images already in a collection rewrites its references in order.
	d, e := newAsset("group 001.png", "image/png", "unrated"), newAsset("group 002.png", "image/png", "general")
	parent := create("existing parent", "collection", []string{d.ID, e.ID})
	grouped := create("grouped", "composite", []string{d.ID, e.ID})
	json.Unmarshal(call(cat.URL, "GET", "/api/v1/series/"+parent.ID, owner, nil, 200), &detail)
	if len(detail.Members) != 1 || detail.Members[0].ID != grouped.ID {
		t.Fatal("existing collection retained hidden images")
	}
	call(cat.URL, "DELETE", "/api/v1/series/"+grouped.ID, owner, nil, 204)
	json.Unmarshal(call(cat.URL, "GET", "/api/v1/series/"+parent.ID, owner, nil, 200), &detail)
	if len(detail.Members) != 2 || detail.Members[0].ID != d.ID || detail.Members[1].ID != e.ID {
		t.Fatal("manual dissolution did not restore originals")
	}

}
