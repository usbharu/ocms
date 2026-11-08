package media

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"ocms/internal/contracts"
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
	blob := uuid.NewString()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	defer exec(`DELETE FROM media.blob_state_outbox WHERE blob_id=$1`, blob)
	defer exec(`DELETE FROM media.processing_jobs WHERE source_blob_id=$1`, blob)
	exec(`INSERT INTO media.processing_jobs(event_id,source_blob_id,job_type,status)
		VALUES(gen_random_uuid(),$1,'media.process','completed')`, blob)

	deliveries := make(chan contracts.BlobProcessingState, 10)
	catalog := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var state contracts.BlobProcessingState
		if r.URL.Path != "/internal/blobs/"+blob+"/processing-state" || json.NewDecoder(r.Body).Decode(&state) != nil {
			t.Error("invalid state notification")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		deliveries <- state
		if state.Status == "ready" && len(deliveries) == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		if state.Status == "processing" {
			// Queue a new revision while the old one is awaiting acknowledgment.
			if _, err := db.Exec(r.Context(), `UPDATE media.processing_jobs SET status='completed' WHERE source_blob_id=$1`, blob); err != nil {
				t.Error(err)
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer catalog.Close()
	t.Setenv("INTERNAL_TOKEN", strings.Repeat("t", 32))
	s := Service{DB: db, Catalog: catalog.URL, SemanticSearchDisabled: true}
	if err := s.deliverBlobStates(ctx); err == nil {
		t.Fatal("expected retryable delivery failure")
	}
	deliver := func() {
		t.Helper()
		if err := s.deliverBlobStates(ctx); err != nil {
			t.Fatal(err)
		}
	}
	deliver()
	if len(deliveries) != 1 {
		t.Fatal("delivery was retried before the lease expired")
	}
	exec(`UPDATE media.blob_state_outbox SET available_at=now() WHERE blob_id=$1`, blob)
	deliver()
	if len(deliveries) != 2 {
		t.Fatal("missing retry")
	}
	first, retry := <-deliveries, <-deliveries
	if first != retry || first.Status != "ready" || first.Revision <= 0 {
		t.Fatalf("retry changed notification: %+v %+v", first, retry)
	}
	deliver()
	exec(`UPDATE media.processing_jobs SET attempts=attempts+1 WHERE source_blob_id=$1`, blob)
	deliver()
	if len(deliveries) != 0 {
		t.Fatal("no Job status change, but a notification was sent")
	}
	exec(`UPDATE media.processing_jobs SET status='failed' WHERE source_blob_id=$1`, blob)
	deliver()
	if len(deliveries) != 1 {
		t.Fatal("missing notification after Job status change")
	}
	if failed := <-deliveries; failed.Status != "failed" || failed.Revision <= first.Revision {
		t.Fatalf("unexpected new state: %+v", failed)
	}

	exec(`UPDATE media.processing_jobs SET status='running' WHERE source_blob_id=$1`, blob)
	deliver()
	if len(deliveries) != 2 {
		t.Fatal("acknowledging the old revision lost a concurrent change")
	}
	processing, completed := <-deliveries, <-deliveries
	if processing.Status != "processing" || completed.Status != "ready" || completed.Revision <= processing.Revision {
		t.Fatalf("unexpected transitions: %+v %+v", processing, completed)
	}

}
