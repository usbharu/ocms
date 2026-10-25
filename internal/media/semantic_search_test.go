package media

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Run only against a disposable database initialized with all migrations.
func TestSemanticSearchQueueDatabase(t *testing.T) {
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
	var blob string
	if err := db.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&blob); err != nil {
		t.Fatal(err)
	}
	defer exec(`DELETE FROM media.processing_jobs WHERE source_blob_id=$1`, blob)
	states := map[string]string{}
	var stateMu sync.Mutex
	state := func() string {
		stateMu.Lock()
		defer stateMu.Unlock()
		return states[blob]
	}
	catalog := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/internal/events" {
			w.Write([]byte(`{"events":[]}`))
			return
		}
		var in struct {
			Status string `json:"status"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			t.Error(err)
		}
		stateMu.Lock()
		states[strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/internal/blobs/"), "/state")] = in.Status
		stateMu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	}))
	defer catalog.Close()
	t.Setenv("INTERNAL_TOKEN", strings.Repeat("t", 32))
	s := Service{DB: db, Catalog: catalog.URL, SemanticSearchDisabled: true}
	exec(`INSERT INTO media.processing_jobs(event_id,source_blob_id,job_type,status) VALUES(gen_random_uuid(),$1,'media.process','completed'),(gen_random_uuid(),$1,'embedding.generate','queued')`, blob)
	// Test audio (no tags Job), all paused statuses, and exhausted expired leases.
	for _, status := range []string{"queued", "retry", "running", "failed"} {
		exec(`UPDATE media.processing_jobs SET status=$2,attempts=CASE WHEN $2='running' THEN 4 ELSE 2 END,locked_until=now()-interval '1 minute' WHERE source_blob_id=$1 AND job_type='embedding.generate'`, blob, status)
		if err := s.tick(ctx); err != nil {
			t.Fatal(err)
		}
		var got string
		var attempts int
		if err := db.QueryRow(ctx, `SELECT status,attempts FROM media.processing_jobs WHERE source_blob_id=$1 AND job_type='embedding.generate'`, blob).Scan(&got, &attempts); err != nil {
			t.Fatal(err)
		}
		wantAttempts := 2
		if status == "running" {
			wantAttempts = 4
		}
		if got != status || attempts != wantAttempts {
			t.Fatalf("paused job changed: %s %d", got, attempts)
		}
		if state() != "ready" {
			t.Fatalf("paused embedding blocked ready: %s", state())
		}
	}
	// Tags continue, and pending or failed non-embedding Jobs still affect state.
	exec(`INSERT INTO media.processing_jobs(event_id,source_blob_id,job_type) VALUES(gen_random_uuid(),$1,'tags.generate')`, blob)
	if err := s.syncStates(ctx); err != nil {
		t.Fatal(err)
	}
	if state() != "processing" {
		t.Fatalf("tags not pending: %s", state())
	}
	job, err := s.claim(ctx)
	if err != nil || job.Type != "tags.generate" {
		t.Fatalf("tags not claimed: %s %v", job.Type, err)
	}
	exec(`UPDATE media.processing_jobs SET status='failed' WHERE id=$1`, job.ID)
	if err := s.syncStates(ctx); err != nil {
		t.Fatal(err)
	}
	if state() != "failed" {
		t.Fatalf("tag failure hidden: %s", state())
	}
	exec(`UPDATE media.processing_jobs SET status='completed' WHERE id=$1`, job.ID)
	if _, err := s.claim(ctx); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("disabled embedding claimed: %v", err)
	}
	// Re-enable: pending embeddings affect state again and retain their retry count.
	exec(`UPDATE media.processing_jobs SET status='retry',attempts=2 WHERE source_blob_id=$1 AND job_type='embedding.generate'`, blob)
	s.SemanticSearchDisabled = false
	if err := s.syncStates(ctx); err != nil {
		t.Fatal(err)
	}
	if state() != "processing" {
		t.Fatalf("embedding not pending on re-enable: %s", state())
	}
	job, err = s.claim(ctx)
	if err != nil || job.Type != "embedding.generate" || job.Attempts != 3 {
		t.Fatalf("embedding not resumed: %+v %v", job, err)
	}
	exec(`UPDATE media.processing_jobs SET status='completed' WHERE id=$1`, job.ID)
	if err := s.syncStates(ctx); err != nil {
		t.Fatal(err)
	}
	if state() != "ready" {
		t.Fatalf("completed embeddings not ready: %s", state())
	}
}
