package catalog_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"ocms/internal/catalog"
	"ocms/internal/contracts"
	"ocms/internal/search"
)

func TestGroupsDatabase(t *testing.T) {
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
		if _, err := db.Exec(ctx, q, args...); err != nil {
			t.Fatal(err)
		}
	}
	principal := func() string {
		t.Helper()
		var id string
		if err := db.QueryRow(ctx, `INSERT INTO catalog.principals(oidc_issuer,oidc_subject) VALUES('groups-test',gen_random_uuid()::text) RETURNING id`).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	owner, other := principal(), principal()
	blobs := []string{}
	defer func() {
		exec(`DELETE FROM catalog.outbox_events WHERE blob_id=ANY($1::uuid[])`, blobs)
		for _, table := range []string{"passages", "embeddings", "perceptual_hashes"} {
			exec(`DELETE FROM search.`+table+` WHERE blob_id=ANY($1::uuid[])`, blobs)
		}
		for _, q := range []string{
			`DELETE FROM catalog.upload_request_keys WHERE principal_id=ANY($1::uuid[])`,
			`DELETE FROM catalog.upload_sessions WHERE asset_id IN(SELECT id FROM catalog.assets WHERE owner_id=ANY($1::uuid[]))`,
			`DELETE FROM catalog.series_members WHERE series_id IN(SELECT id FROM catalog.assets WHERE owner_id=ANY($1::uuid[]))`,
			`DELETE FROM catalog.series WHERE asset_id IN(SELECT id FROM catalog.assets WHERE owner_id=ANY($1::uuid[]))`,
			`DELETE FROM catalog.asset_originals WHERE asset_id IN(SELECT id FROM catalog.assets WHERE owner_id=ANY($1::uuid[]))`,
			`DELETE FROM catalog.grants WHERE asset_id IN(SELECT id FROM catalog.assets WHERE owner_id=ANY($1::uuid[]))`,
			`DELETE FROM catalog.assets WHERE owner_id=ANY($1::uuid[])`,
			`DELETE FROM catalog.principals WHERE id=ANY($1::uuid[])`,
		} {
			exec(q, []string{owner, other})
		}
	}()
	token := strings.Repeat("g", 32)
	t.Setenv("INTERNAL_TOKEN", token)
	cat := httptest.NewServer((&catalog.Service{DB: db, MaxSize: 1024}).Handler())
	defer cat.Close()
	vector := make([]float64, 768)
	vector[0] = 1
	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(contracts.Embedding{Model: "groups-test", Revision: "1", Vector: vector})
	}))
	defer runtime.Close()
	srch := httptest.NewServer((&search.Service{DB: db, Catalog: cat.URL, Runtime: runtime.URL}).Handler())
	defer srch.Close()
	call := func(base, method, path, user string, body any, status int, key string) []byte {
		t.Helper()
		data, _ := json.Marshal(body)
		req, _ := http.NewRequest(method, base+path, bytes.NewReader(data))
		req.Header.Set("X-Service-Token", token)
		req.Header.Set("X-Principal", user)
		req.Header.Set("Idempotency-Key", key)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var b bytes.Buffer
		b.ReadFrom(res.Body)
		if res.StatusCode != status {
			t.Fatalf("%s %s: got %d want %d (%s)", method, path, res.StatusCode, status, b.String())
		}
		return b.Bytes()
	}
	group := func(name string) string {
		var g catalog.Group
		json.Unmarshal(call(cat.URL, "POST", "/api/v1/groups", owner, map[string]any{"name": name}, 201, ""), &g)
		return g.ID
	}
	g, h := group("Work"), group("Books")
	var ownGroups, otherGroups struct{ Groups []catalog.Group }
	json.Unmarshal(call(cat.URL, "GET", "/api/v1/groups", owner, nil, 200, ""), &ownGroups)
	json.Unmarshal(call(cat.URL, "GET", "/api/v1/groups", other, nil, 200, ""), &otherGroups)
	if len(ownGroups.Groups) != 4 || len(otherGroups.Groups) != 2 || otherGroups.Groups[0].ID != "default" || otherGroups.Groups[1].ID != "all" {
		t.Fatal("group list leaked another user's groups")
	}
	call(cat.URL, "PATCH", "/api/v1/groups/"+g, owner, map[string]any{"name": "New Work"}, 200, "")
	call(cat.URL, "PATCH", "/api/v1/groups/"+g, owner, map[string]any{"name": "Books"}, 409, "")
	call(cat.URL, "PATCH", "/api/v1/groups/"+g, owner, map[string]any{"name": "Work"}, 200, "")

	for _, name := range []string{"", "default", "ALL"} {
		call(cat.URL, "POST", "/api/v1/groups", owner, map[string]any{"name": name}, 400, "")
	}
	call(cat.URL, "POST", "/api/v1/groups", owner, map[string]any{"name": "Work"}, 409, "")
	call(cat.URL, "PATCH", "/api/v1/groups/"+g, other, map[string]any{"name": "stolen"}, 404, "")
	call(cat.URL, "DELETE", "/api/v1/groups/default", owner, nil, 404, "")
	call(cat.URL, "GET", "/api/v1/assets?group_id="+g, other, nil, 404, "")
	call(cat.URL, "GET", "/api/v1/assets?group_id=", owner, nil, 400, "")
	asset := func(name string) string {
		var id string
		if err := db.QueryRow(ctx, `INSERT INTO catalog.assets(owner_id,filename,mime_type,status,tags) VALUES($1,$2,'image/png','ready',ARRAY['groups-token']) RETURNING id`, owner, name).Scan(&id); err != nil {
			t.Fatal(err)
		}
		exec(`INSERT INTO catalog.asset_originals(asset_id,blob_id) VALUES($1,gen_random_uuid())`, id)
		return id
	}
	a, b, c := asset("A"), asset("B"), asset("C")
	// Shared Blob must not imply shared membership.
	exec(`UPDATE catalog.asset_originals SET blob_id=(SELECT blob_id FROM catalog.asset_originals WHERE asset_id=$1) WHERE asset_id=$2`, a, c)
	list := func(path, user string, want []string, total int) {
		t.Helper()
		var out struct {
			Assets []catalog.Asset
			Total  int
		}
		json.Unmarshal(call(cat.URL, "GET", path, user, nil, 200, ""), &out)
		ids := []string{}
		for _, a := range out.Assets {
			ids = append(ids, a.ID)
		}
		sort.Strings(ids)
		sort.Strings(want)
		if !reflect.DeepEqual(ids, want) || out.Total != total {
			t.Fatalf("wrong list %s: got %v total %d want %v total %d", path, ids, out.Total, want, total)
		}
	}
	list("/api/v1/assets?group_id=default", owner, []string{a, b, c}, 3)
	save := func(id, user string, ids []string, status int) {
		call(cat.URL, "PUT", "/api/v1/assets/"+id+"/groups", user, map[string]any{"group_ids": ids}, status, "")
	}
	save(a, owner, []string{g, h, "all"}, 200)
	list("/api/v1/assets?group_id=default", owner, []string{b, c}, 2)
	list("/api/v1/assets?group_id="+g, owner, []string{a}, 1)
	list("/api/v1/assets?group_id="+h+"&limit=1&offset=1", owner, []string{}, 1)
	list("/api/v1/assets?group_id=all", owner, []string{a, b, c}, 3)
	list("/api/v1/assets", owner, []string{a, b, c}, 3)
	save(b, other, []string{g}, 404)
	exec(`INSERT INTO catalog.grants(asset_id,principal_id,permission) VALUES($1,$2,'read')`, a, other)
	list("/api/v1/assets?group_id=default", other, []string{a}, 1)
	save(a, other, []string{}, 200)
	list("/api/v1/assets?group_id=default", other, []string{}, 0)
	save(a, other, []string{g}, 404)
	exec(`DELETE FROM catalog.grants WHERE asset_id=$1`, a)
	call(cat.URL, "GET", "/api/v1/assets/"+a+"/groups", other, nil, 404, "")
	// Final authorization filters before result limits and uses the display Asset.
	var blob string
	db.QueryRow(ctx, `SELECT blob_id FROM catalog.asset_originals WHERE asset_id=$1`, a).Scan(&blob)
	var hits struct{ Assets []catalog.Asset }
	json.Unmarshal(call(cat.URL, "POST", "/internal/authorize-blobs", owner, map[string]any{"blob_ids": []string{blob}, "group_id": g}, 200, ""), &hits)
	if len(hits.Assets) != 1 || hits.Assets[0].ID != a {
		t.Fatal("shared Blob leaked membership")
	}
	json.Unmarshal(call(srch.URL, "POST", "/api/v1/search", owner, map[string]any{"query": "groups-token", "mode": "keyword", "group_id": g, "limit": 1}, 200, ""), &hits)
	if len(hits.Assets) != 1 || hits.Assets[0].ID != a {
		t.Fatal("search lost group scope")
	}
	// Exercise indexed search and final scoped ranking with a shared Blob and lower-ranked membership.
	for _, id := range []string{a, b} {
		var blob string
		if err := db.QueryRow(ctx, `SELECT blob_id FROM catalog.asset_originals WHERE asset_id=$1`, id).Scan(&blob); err != nil {
			t.Fatal(err)
		}
		blobs = append(blobs, blob)
		raw, _ := json.Marshal(vector)
		exec(`INSERT INTO search.passages(blob_id,kind,ordinal,content) VALUES($1,'ocr',0,'groupindexedfixture')`, blob)
		exec(`INSERT INTO search.embeddings(blob_id,source_type,ordinal,model_id,model_revision,embedding) VALUES($1,'image',0,'groups-test','1',$2::vector)`, blob, string(raw))
		exec(`INSERT INTO search.perceptual_hashes(blob_id,kind,ordinal,phash) VALUES($1,'image',0,B'0000000000000000000000000000000000000000000000000000000000000000')`, blob)
	}
	for _, mode := range []string{"keyword", "semantic", "hybrid", "perceptual"} {
		json.Unmarshal(call(srch.URL, "POST", "/api/v1/search", owner, map[string]any{"query": "groupindexedfixture", "mode": mode, "asset_id": b, "group_id": g, "limit": 1}, 200, ""), &hits)
		if len(hits.Assets) != 1 || hits.Assets[0].ID != a {
			t.Fatalf("%s search lost membership", mode)
		}
	}
	// A duplicate is in scope only when its own Asset is assigned.
	save(c, owner, []string{h}, 200)
	json.Unmarshal(call(cat.URL, "GET", "/api/v1/assets/"+a+"/duplicates?group_id="+h, owner, nil, 200, ""), &hits)
	if len(hits.Assets) != 1 || hits.Assets[0].ID != c {
		t.Fatal("duplicate scope lost")
	}
	json.Unmarshal(call(srch.URL, "GET", "/api/v1/assets/"+b+"/recommendations?group_id="+g, owner, nil, 200, ""), &hits)
	if len(hits.Assets) != 1 || hits.Assets[0].ID != a {
		t.Fatal("related recommendations lost group scope")
	}
	// Restore default for c before the final default assertion.
	save(c, owner, []string{h, "default"}, 200)
	// Re-uploading an existing logical Asset applies the destination instead of losing it with the temporary Asset.
	var duplicateUpload catalog.Upload
	json.Unmarshal(call(cat.URL, "POST", "/api/v1/uploads", owner, map[string]any{"filename": "B", "mime_type": "image/png", "size_bytes": 1, "group_id": g}, 201, "duplicate-upload-group"), &duplicateUpload)
	var duplicateBlob string
	if err := db.QueryRow(ctx, `SELECT blob_id FROM catalog.asset_originals WHERE asset_id=$1`, b).Scan(&duplicateBlob); err != nil {
		t.Fatal(err)
	}
	call(cat.URL, "POST", "/internal/uploads/"+duplicateUpload.ID+"/complete", owner, map[string]any{"blob_id": duplicateBlob}, 200, "")
	list("/api/v1/assets?group_id="+g, owner, []string{a, b}, 2)
	save(b, owner, []string{"default"}, 200)
	// Series group memberships are independent of constituents, and all hides both series and composite images.
	var series catalog.Asset
	json.Unmarshal(call(cat.URL, "POST", "/api/v1/series", owner, map[string]any{"name": "Comic", "kind": "composite", "member_ids": []string{a, b}}, 200, ""), &series)
	list("/api/v1/assets?group_id="+g, owner, []string{}, 0)
	save(series.ID, owner, []string{g, "default"}, 200)
	list("/api/v1/assets?group_id="+g, owner, []string{series.ID}, 1)
	for _, mode := range []string{"keyword", "semantic", "hybrid"} {
		json.Unmarshal(call(srch.URL, "POST", "/api/v1/search", owner, map[string]any{"query": "groupindexedfixture", "mode": mode, "group_id": g, "limit": 1}, 200, ""), &hits)
		if len(hits.Assets) != 1 || hits.Assets[0].ID != series.ID {
			t.Fatal("indexed series scope lost")
		}
	}

	list("/api/v1/assets?group_id=all", owner, []string{c}, 1)
	save(series.ID, owner, []string{"all"}, 400)
	// Upload request idempotency survives deletion of its initial group.
	payload := map[string]any{"filename": "upload.png", "mime_type": "image/png", "size_bytes": 1, "group_id": h}
	raw := call(cat.URL, "POST", "/api/v1/uploads", owner, payload, 201, "upload-group-key")
	var upload catalog.Upload
	json.Unmarshal(raw, &upload)
	call(cat.URL, "DELETE", "/api/v1/groups/"+h, owner, nil, 204, "")
	raw = call(cat.URL, "POST", "/api/v1/uploads", owner, payload, 201, "upload-group-key")
	var retry catalog.Upload
	json.Unmarshal(raw, &retry)
	call(cat.URL, "GET", "/api/v1/uploads/"+upload.ID, owner, nil, 200, "")
	if upload.ID != retry.ID {
		t.Fatal("retry created another upload")
	}
	payload["group_id"] = "default"
	call(cat.URL, "POST", "/api/v1/uploads", owner, payload, 409, "upload-group-key")
	var membership struct {
		IDs []string `json:"group_ids"`
	}
	json.Unmarshal(call(cat.URL, "GET", "/api/v1/assets/"+upload.AssetID+"/groups", owner, nil, 200, ""), &membership)
	if !reflect.DeepEqual(membership.IDs, []string{"all"}) {
		t.Fatal("deleting group moved upload to default")
	}
	call(cat.URL, "DELETE", "/api/v1/groups/"+g, owner, nil, 204, "")
	list("/api/v1/assets?group_id=default", owner, []string{series.ID, c}, 2)
}
