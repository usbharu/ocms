package media

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestStateReconciliationDatabase(t *testing.T) {
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

	first, second := uuid.NewString(), uuid.NewString()
	defer func() {
		if _, err := db.Exec(ctx, `DELETE FROM media.processing_jobs WHERE source_blob_id IN ($1,$2)`, first, second); err != nil {
			t.Error(err)
		}
	}()
	for _, blob := range []string{first, second} {
		if _, err := db.Exec(ctx, `INSERT INTO media.processing_jobs(event_id,source_blob_id,job_type,status)
			VALUES(gen_random_uuid(),$1,'media.process','completed')`, blob); err != nil {
			t.Fatal(err)
		}
	}

	var mu sync.Mutex
	calls := map[string]int{}
	fail := false
	catalog := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/internal/events" {
			w.Write([]byte(`{"events":[]}`))
			return
		}
		mu.Lock()
		defer mu.Unlock()
		calls[r.URL.Path]++
		if fail {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer catalog.Close()
	t.Setenv("INTERNAL_TOKEN", strings.Repeat("t", 32))
	s := Service{DB: db, Catalog: catalog.URL, SemanticSearchDisabled: true}
	checkCalls := func(wantFirst, wantSecond int) {
		t.Helper()
		mu.Lock()
		defer mu.Unlock()
		if calls["/internal/blobs/"+first+"/state"] != wantFirst || calls["/internal/blobs/"+second+"/state"] != wantSecond {
			t.Errorf("unexpected reconciliation counts: first=%d second=%d, want %d/%d",
				calls["/internal/blobs/"+first+"/state"], calls["/internal/blobs/"+second+"/state"], wantFirst, wantSecond)
		}
	}

	for range 4 {
		if err := s.tick(ctx); err != nil {
			t.Fatal(err)
		}
	}
	checkCalls(1, 1)
	if err := s.syncStates(ctx, first); err != nil {
		t.Fatal(err)
	}
	checkCalls(2, 1)

	// Catalog can acquire a new Asset for an already completed Blob without a new Job.
	s.nextStateReconciliation = time.Time{}
	if err := s.tick(ctx); err != nil {
		t.Fatal(err)
	}
	checkCalls(3, 2)

	mu.Lock()
	fail = true
	mu.Unlock()
	s.nextStateReconciliation = time.Time{}
	if err := s.tick(ctx); err == nil {
		t.Fatal("expected Catalog failure")
	}
	mu.Lock()
	firstAfterFailure, secondAfterFailure := calls["/internal/blobs/"+first+"/state"], calls["/internal/blobs/"+second+"/state"]
	fail = false
	mu.Unlock()
	if err := s.tick(ctx); err != nil {
		t.Fatal(err)
	}
	checkCalls(firstAfterFailure, secondAfterFailure)
	s.nextStateReconciliation = time.Time{}
	if err := s.tick(ctx); err != nil {
		t.Fatal(err)
	}
	checkCalls(firstAfterFailure+1, secondAfterFailure+1)
}
