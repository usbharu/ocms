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
	"time"

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

func TestConcurrentClaimsDatabase(t *testing.T) {
	dsn := os.Getenv("OCMS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("requires disposable migrated OCMS_TEST_DATABASE_URL")
	}
	ctx := context.Background()
	db, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var blobs []string
	defer func() {
		_, _ = db.Exec(ctx, `DELETE FROM media.processing_jobs WHERE source_blob_id::text=ANY($1)`, blobs)
	}()
	for range 4 {
		var blob string
		if err := db.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&blob); err != nil {
			t.Fatal(err)
		}
		blobs = append(blobs, blob)
		if _, err := db.Exec(ctx, `INSERT INTO media.processing_jobs(event_id,source_blob_id,job_type) VALUES(gen_random_uuid(),$1,'media.process')`, blob); err != nil {
			t.Fatal(err)
		}
	}

	s := Service{DB: db}
	var wg sync.WaitGroup
	jobs := make(chan string, 4)
	errs := make(chan error, 4)
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			j, err := s.claim(ctx)
			if err != nil {
				errs <- err
				return
			}
			jobs <- j.ID
		}()
	}
	wg.Wait()
	close(jobs)
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	seen := map[string]bool{}
	for id := range jobs {
		if seen[id] {
			t.Fatal("job claimed twice")
		}
		seen[id] = true
	}
	if len(seen) != 4 {
		t.Fatalf("claimed %d jobs, expected 4", len(seen))
	}
}

func TestConcurrentWorkersDatabase(t *testing.T) {
	dsn := os.Getenv("OCMS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("requires disposable migrated OCMS_TEST_DATABASE_URL")
	}
	ctx := context.Background()
	db, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var blobs []string
	for range 2 {
		var blob string
		if err := db.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&blob); err != nil {
			t.Fatal(err)
		}
		blobs = append(blobs, blob)
		if _, err := db.Exec(ctx, `INSERT INTO media.processing_jobs(event_id,source_blob_id,job_type,attempts) VALUES(gen_random_uuid(),$1,'media.process',3)`, blob); err != nil {
			t.Fatal(err)
		}
	}
	defer db.Exec(ctx, `DELETE FROM media.processing_jobs WHERE source_blob_id::text=ANY($1)`, blobs)
	t.Setenv("INTERNAL_TOKEN", strings.Repeat("t", 32))
	catalog := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/internal/events" {
			w.Write([]byte(`{"events":[]}`))
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer catalog.Close()
	started := make(chan string, 2)
	transfer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started <- r.URL.Path
		<-r.Context().Done()
	}))
	defer transfer.Close()
	s := &Service{DB: db, Catalog: catalog.URL, Transfer: transfer.URL, Concurrency: 2}
	workerCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { defer close(done); s.Run(workerCtx) }()
	defer func() { cancel(); <-done }()
	seen := map[string]bool{}
	for range 2 {
		select {
		case path := <-started:
			if seen[path] {
				t.Fatal("workers processed the same blob")
			}
			seen[path] = true
		case <-time.After(10 * time.Second):
			t.Fatal("workers did not start two jobs simultaneously")
		}
	}
	var running int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM media.processing_jobs WHERE source_blob_id::text=ANY($1) AND status='running'`, blobs).Scan(&running); err != nil || running != 2 {
		t.Fatalf("expected two leased jobs: %d, %v", running, err)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("workers did not stop")
	}
	var retried int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM media.processing_jobs WHERE source_blob_id::text=ANY($1) AND status='retry' AND locked_until IS NULL AND attempts=3`, blobs).Scan(&retried); err != nil || retried != 2 {
		t.Fatalf("cancelled jobs were not released for retry: %d, %v", retried, err)
	}
}
