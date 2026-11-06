package media

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"ocms/internal/contracts"
	"ocms/internal/platform"
)

// A change in the semantic-search policy changes how existing Jobs aggregate.
// Persist the setting so restarting with the same policy does not scan history.
func (s *Service) initializeBlobStates(ctx context.Context) error {
	_, err := s.DB.Exec(ctx, `WITH changed AS (
		UPDATE media.blob_state_settings SET semantic_search_disabled=$1
		WHERE singleton AND semantic_search_disabled IS DISTINCT FROM $1 RETURNING 1
	)
	INSERT INTO media.blob_state_outbox(blob_id)
	SELECT DISTINCT source_blob_id FROM media.processing_jobs WHERE EXISTS (SELECT 1 FROM changed)
	ON CONFLICT(blob_id) DO UPDATE SET revision=nextval('media.blob_state_revision'),available_at=now()`, s.SemanticSearchDisabled)
	return err
}

func (s *Service) deliverBlobStates(ctx context.Context) error {
	var deliveryErr error
	for range 100 {
		var blob string
		var state contracts.BlobProcessingState
		err := s.DB.QueryRow(ctx, `WITH next AS (
			SELECT blob_id FROM media.blob_state_outbox WHERE available_at<=now()
			ORDER BY available_at,blob_id FOR UPDATE SKIP LOCKED LIMIT 1
		)
		UPDATE media.blob_state_outbox o SET available_at=now()+interval '30 seconds'
		FROM next WHERE o.blob_id=next.blob_id RETURNING o.blob_id,o.revision`).Scan(&blob, &state.Revision)
		if errors.Is(err, pgx.ErrNoRows) {
			return deliveryErr
		}
		if err != nil {
			return errors.Join(deliveryErr, err)
		}

		if err := s.deliverBlobState(ctx, blob, state); err != nil {
			// The lease makes the row eligible again after a failure or process exit.
			deliveryErr = err
		}
	}
	return deliveryErr
}

func (s *Service) deliverBlobState(ctx context.Context, blob string, state contracts.BlobProcessingState) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	err := s.DB.QueryRow(ctx, `SELECT CASE
		WHEN bool_or(status='failed') THEN 'failed'
		WHEN count(*)>=CASE WHEN $2::boolean THEN 1 ELSE 2 END AND bool_and(status='completed') THEN 'ready'
		ELSE 'processing' END
		FROM media.processing_jobs WHERE source_blob_id=$1 AND NOT ($2::boolean AND job_type='embedding.generate')
		GROUP BY source_blob_id`, blob, s.SemanticSearchDisabled).Scan(&state.Status)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if err == nil {
		if err = platform.Call(ctx, "POST", s.Catalog+"/internal/blobs/"+blob+"/processing-state", "", state, nil); err != nil {
			return err
		}
	}
	// Never acknowledge a newer revision that was queued during delivery.
	_, err = s.DB.Exec(ctx, `DELETE FROM media.blob_state_outbox WHERE blob_id=$1 AND revision=$2`, blob, state.Revision)
	return err
}
