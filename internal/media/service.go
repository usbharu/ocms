package media

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	"ocms/internal/catalog"
	"ocms/internal/contracts"
	"ocms/internal/platform"
)

type Service struct {
	SemanticSearchDisabled             bool
	DB                                 *pgxpool.Pool
	Catalog, Transfer, Search, Runtime string
}

func New(db *pgxpool.Pool) *Service {
	return &Service{DB: db, Catalog: os.Getenv("CATALOG_URL"), Transfer: os.Getenv("TRANSFER_URL"), Search: os.Getenv("SEARCH_URL"), Runtime: os.Getenv("RUNTIME_URL")}
}
func (s *Service) Handler() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("POST /internal/jobs/{id}/authorize", s.authorize)
	m.HandleFunc("GET /api/v1/jobs/{id}", s.getJob)
	m.HandleFunc("GET /api/v1/assets/{id}/jobs", s.assetJobs)
	m.HandleFunc("GET /api/v1/assets/{id}/renditions", s.renditions)
	m.HandleFunc("POST /api/v1/assets/{id}/renditions", s.enqueue)
	return platform.Internal(m)
}
func (s *Service) asset(r *http.Request) (catalog.Asset, error) {
	var a catalog.Asset
	err := platform.Call(r.Context(), "GET", s.Catalog+"/api/v1/assets/"+r.PathValue("id"), r.Header.Get("X-Principal"), nil, &a)
	if err == nil && a.BlobID == nil {
		err = &platform.HTTPError{Status: 409}
	}
	return a, err
}
func (s *Service) authorize(w http.ResponseWriter, r *http.Request) {
	var in struct {
		BlobID string `json:"blob_id"`
		Lease  string `json:"lease_token"`
	}
	if !platform.Decode(w, r, &in) {
		return
	}
	var allowed bool
	err := s.DB.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM media.processing_jobs WHERE id::text=$1 AND source_blob_id::text=$2 AND lease_token::text=$3 AND status='running' AND locked_until>now())`, r.PathValue("id"), in.BlobID, in.Lease).Scan(&allowed)
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	if !allowed {
		platform.Error(w, 403, "JOB_FORBIDDEN")
		return
	}
	w.WriteHeader(204)
}
func (s *Service) renditions(w http.ResponseWriter, r *http.Request) {
	a, err := s.asset(r)
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	rows, err := s.DB.Query(r.Context(), `SELECT id,source_blob_id,output_blob_id,profile_id,mime_type FROM media.renditions WHERE source_blob_id=$1 ORDER BY profile_id`, *a.BlobID)
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	defer rows.Close()
	out := []contracts.Rendition{}
	for rows.Next() {
		var d contracts.Rendition
		if err = rows.Scan(&d.ID, &d.Source, &d.BlobID, &d.Profile, &d.MIME); err != nil {
			platform.RespondError(w, err)
			return
		}
		out = append(out, d)
	}
	if rows.Err() != nil {
		platform.RespondError(w, rows.Err())
		return
	}
	platform.JSON(w, 200, map[string]any{"renditions": out})
}
func (s *Service) enqueue(w http.ResponseWriter, r *http.Request) {
	var a catalog.Asset
	err := platform.Call(r.Context(), "GET", s.Catalog+"/internal/assets/"+r.PathValue("id")+"/authorize?action=write", r.Header.Get("X-Principal"), nil, &a)
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	if a.BlobID == nil {
		platform.Error(w, 409, "INDEX_PENDING")
		return
	}
	var in struct {
		Profile string `json:"profile_id"`
	}
	if !platform.Decode(w, r, &in) {
		return
	}
	if in.Profile != "" && !validProfile(a.MIME, in.Profile) {
		platform.Error(w, 400, "PROFILE_UNSUPPORTED")
		return
	}
	_, err = s.DB.Exec(r.Context(), `UPDATE media.processing_jobs SET status='retry',attempts=0,error_code=NULL,available_at=now() WHERE source_blob_id=$1 AND status='failed'`, *a.BlobID)
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	var j contracts.Job
	err = s.DB.QueryRow(r.Context(), `INSERT INTO media.processing_jobs(event_id,source_blob_id,job_type) VALUES(gen_random_uuid(),$1,'media.process') ON CONFLICT(source_blob_id,job_type,pipeline_version) DO UPDATE SET status=CASE WHEN media.processing_jobs.status='failed' THEN 'retry' ELSE media.processing_jobs.status END,attempts=CASE WHEN media.processing_jobs.status='failed' THEN 0 ELSE media.processing_jobs.attempts END,available_at=now() RETURNING id,source_blob_id,job_type,status,attempts,error_code`, *a.BlobID).Scan(&j.ID, &j.BlobID, &j.Type, &j.Status, &j.Attempts, &j.Error)
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	platform.JSON(w, 202, j)
}
func (s *Service) getJob(w http.ResponseWriter, r *http.Request) {
	var j contracts.Job
	err := s.DB.QueryRow(r.Context(), `SELECT id,source_blob_id,job_type,status,attempts,error_code FROM media.processing_jobs WHERE id::text=$1`, r.PathValue("id")).Scan(&j.ID, &j.BlobID, &j.Type, &j.Status, &j.Attempts, &j.Error)
	if errors.Is(err, pgx.ErrNoRows) {
		platform.Error(w, 404, "NOT_FOUND")
		return
	}
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	var out struct {
		Assets []catalog.Asset `json:"assets"`
	}
	err = platform.Call(r.Context(), "POST", s.Catalog+"/internal/authorize-blobs", r.Header.Get("X-Principal"), map[string]any{"blob_ids": []string{j.BlobID}}, &out)
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	if len(out.Assets) == 0 {
		platform.Error(w, 404, "NOT_FOUND")
		return
	}
	platform.JSON(w, 200, j)
}
func (s *Service) assetJobs(w http.ResponseWriter, r *http.Request) {
	a, err := s.asset(r)
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	rows, err := s.DB.Query(r.Context(), `SELECT id,source_blob_id,job_type,status,attempts,error_code FROM media.processing_jobs WHERE source_blob_id=$1 ORDER BY created_at`, *a.BlobID)
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	defer rows.Close()
	jobs := []contracts.Job{}
	for rows.Next() {
		var j contracts.Job
		if err = rows.Scan(&j.ID, &j.BlobID, &j.Type, &j.Status, &j.Attempts, &j.Error); err != nil {
			platform.RespondError(w, err)
			return
		}
		jobs = append(jobs, j)
	}
	if rows.Err() != nil {
		platform.RespondError(w, rows.Err())
		return
	}
	platform.JSON(w, 200, map[string]any{"jobs": jobs})
}
func (s *Service) Run(ctx context.Context) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		if err := s.tick(ctx); err != nil && ctx.Err() == nil {
			slog.WarnContext(ctx, "media.queue_retry")
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
func (s *Service) tick(ctx context.Context) error {
	if _, err := s.DB.Exec(ctx, `UPDATE media.processing_jobs SET status='failed',error_code='LEASE_EXHAUSTED',locked_until=NULL WHERE status='running' AND locked_until<now() AND attempts>=4 AND (NOT $1::boolean OR job_type<>'embedding.generate')`, s.SemanticSearchDisabled); err != nil {
		return err
	}

	var events struct {
		Events []contracts.Event `json:"events"`
	}
	if err := platform.Call(ctx, "GET", s.Catalog+"/internal/events", "", nil, &events); err != nil {
		return err
	}
	for _, event := range events.Events {
		_, err := s.DB.Exec(ctx, `INSERT INTO media.processing_jobs(event_id,source_blob_id,job_type,traceparent) VALUES($1,$2,'media.process',$3) ON CONFLICT DO NOTHING`, event.ID, event.BlobID, event.Traceparent)
		if err != nil {
			return err
		}
		if err = platform.Call(ctx, "POST", s.Catalog+"/internal/events/"+event.ID+"/ack", "", nil, nil); err != nil {
			return err
		}
	}
	j, err := s.claim(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return s.syncStates(ctx)
	}
	if err != nil {
		return err
	}
	jobCtx := otel.GetTextMapPropagator().Extract(ctx, propagation.MapCarrier{"traceparent": j.Traceparent})
	jobCtx, span := otel.Tracer("media").Start(jobCtx, j.Type)
	defer span.End()
	jobCtx, cancel := context.WithTimeout(platform.WithJob(jobCtx, j.ID, j.Lease), jobTimeout())
	defer cancel()
	done := make(chan struct{})
	defer close(done)
	go s.heartbeat(jobCtx, cancel, j, done)
	_ = s.state(jobCtx, j.BlobID, "processing")
	slog.InfoContext(jobCtx, "media.job_started", "job_id", j.ID, "job_type", j.Type, "attempt", j.Attempts)
	if j.Type == "media.process" {
		err = s.process(jobCtx, j)
	} else if j.Type == "tags.generate" {
		err = s.tag(jobCtx, j)
	} else {
		err = s.embed(jobCtx, j)
	}
	finishCtx, finishCancel := context.WithTimeout(ctx, 10*time.Second)
	defer finishCancel()
	if err != nil {
		if jobCtx.Err() != nil {
			err = jobCtx.Err()
		}
		span.SetStatus(codes.Error, errorCode(err))
		if j.Type == "media.process" {
			slog.WarnContext(jobCtx, "media.transcode_failed", "job_id", j.ID, "error_code", errorCode(err), "outcome", "failed")
		}
		status := "retry"
		if j.Attempts >= 4 || !retryable(err) {
			status = "failed"
		}
		_, e := s.DB.Exec(finishCtx, `UPDATE media.processing_jobs SET status=$3,error_code=$4,locked_until=NULL,available_at=now()+($5*interval '1 second'),updated_at=now() WHERE id=$1 AND lease_token=$2`, j.ID, j.Lease, status, errorCode(err), j.Attempts*j.Attempts*5)
		platform.Count(jobCtx, "media.job.completed", 1, attribute.String("outcome", status), attribute.String("job_type", j.Type))
		slog.WarnContext(jobCtx, "media.job_failed", "job_id", j.ID, "error_code", errorCode(err), "status", status)
		if e != nil {
			return e
		}
		return s.syncStates(finishCtx)
	}
	tx, err := s.DB.Begin(finishCtx)
	if err != nil {
		return err
	}
	defer tx.Rollback(finishCtx)
	tag, err := tx.Exec(finishCtx, `UPDATE media.processing_jobs SET status='completed',error_code=NULL,locked_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2 AND status='running'`, j.ID, j.Lease)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errors.New("lease lost")
	}
	if j.Type == "media.process" {
		var mime string
		if err = tx.QueryRow(finishCtx, `SELECT mime_type FROM media.blob_metadata WHERE blob_id=$1`, j.BlobID).Scan(&mime); err != nil {
			return err
		}
		// Queue lightweight tags before potentially long embedding inference.
		if taggable(mime) {
			_, err = tx.Exec(finishCtx, `INSERT INTO media.processing_jobs(event_id,source_blob_id,job_type,traceparent) SELECT event_id,source_blob_id,'tags.generate',traceparent FROM media.processing_jobs WHERE id=$1 ON CONFLICT DO NOTHING`, j.ID)
			if err != nil {
				return err
			}
		}
		_, err = tx.Exec(finishCtx, `INSERT INTO media.processing_jobs(event_id,source_blob_id,job_type,traceparent) SELECT event_id,source_blob_id,'embedding.generate',traceparent FROM media.processing_jobs WHERE id=$1 ON CONFLICT DO NOTHING`, j.ID)
		if err != nil {
			return err
		}
	}
	if j.Type == "embedding.generate" {
		if _, err = tx.Exec(finishCtx, `DELETE FROM media.embedding_checkpoints WHERE job_id=$1`, j.ID); err != nil {
			return err
		}
	}
	if err = tx.Commit(finishCtx); err != nil {
		return err
	}
	platform.Count(jobCtx, "media.job.completed", 1, attribute.String("outcome", "completed"), attribute.String("job_type", j.Type))
	slog.InfoContext(jobCtx, "media.job_completed", "job_id", j.ID, "job_type", j.Type)
	return s.syncStates(finishCtx)
}

// Disabled embedding jobs remain queued (including expired leases) for re-enabling.
func (s *Service) claim(ctx context.Context) (contracts.Job, error) {
	var j contracts.Job
	err := s.DB.QueryRow(ctx, `WITH next AS (SELECT id FROM media.processing_jobs WHERE ((status IN ('queued','retry') AND available_at<=now()) OR (status='running' AND locked_until<now())) AND attempts<4 AND (NOT $1::boolean OR job_type<>'embedding.generate') ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE media.processing_jobs j SET status='running',attempts=attempts+1,lease_token=gen_random_uuid(),locked_until=now()+interval '90 seconds',updated_at=now() FROM next WHERE j.id=next.id RETURNING j.id,j.source_blob_id,j.job_type,j.status,j.attempts,j.lease_token,j.traceparent`, s.SemanticSearchDisabled).Scan(&j.ID, &j.BlobID, &j.Type, &j.Status, &j.Attempts, &j.Lease, &j.Traceparent)
	return j, err
}

func (s *Service) heartbeat(ctx context.Context, cancel context.CancelFunc, j contracts.Job, done <-chan struct{}) {
	timer := time.NewTicker(20 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-done:
			return
		case <-ctx.Done():
			return
		case <-timer.C:
			tag, err := s.DB.Exec(ctx, `UPDATE media.processing_jobs SET locked_until=now()+interval '90 seconds' WHERE id=$1 AND lease_token=$2 AND status='running'`, j.ID, j.Lease)
			if err != nil || tag.RowsAffected() == 0 {
				cancel()
				return
			}
		}
	}
}
func (s *Service) state(ctx context.Context, blob, status string) error {
	return platform.Call(ctx, "POST", s.Catalog+"/internal/blobs/"+blob+"/state", "", map[string]string{"status": status}, nil)
}
func (s *Service) syncStates(ctx context.Context) error {
	// Periodic reconciliation includes Assets added after a shared Blob completed.
	// Paused embeddings must not keep otherwise completed media processing pending.
	rows, err := s.DB.Query(ctx, `SELECT source_blob_id,CASE WHEN bool_or(status='failed') THEN 'failed' WHEN count(*)>=CASE WHEN $1::boolean THEN 1 ELSE 2 END AND bool_and(status='completed') THEN 'ready' ELSE 'processing' END FROM media.processing_jobs WHERE NOT $1::boolean OR job_type<>'embedding.generate' GROUP BY source_blob_id`, s.SemanticSearchDisabled)
	if err != nil {
		return err
	}
	type item struct{ blob, status string }
	var states []item
	for rows.Next() {
		var i item
		if err = rows.Scan(&i.blob, &i.status); err != nil {
			rows.Close()
			return err
		}
		states = append(states, i)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, i := range states {
		if err = s.state(ctx, i.blob, i.status); err != nil {
			return err
		}
	}
	return nil
}

type processingError string

func (e processingError) Error() string { return string(e) }
func errorCode(err error) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return "JOB_DEADLINE_EXCEEDED"
	}
	if errors.Is(err, context.Canceled) {
		return "JOB_CANCELLED"
	}
	var e processingError
	if errors.As(err, &e) {
		return string(e)
	}
	return "PROCESSING_FAILED"
}

// Invalid media and explicit limits require a new input or configuration, not a retry loop.
func retryable(err error) bool {
	switch errorCode(err) {
	case "INVALID_INFERENCE_INPUT", "MIME_MISMATCH", "MEDIA_INVALID_DATA", "MEDIA_UNSUPPORTED", "MEDIA_TOO_LARGE", "OUTPUT_TOO_LARGE", "PDF_PAGE_LIMIT", "MEDIA_DIMENSIONS_EXCEEDED", "MEDIA_DURATION_EXCEEDED":
		return false
	default:
		return true
	}
}
