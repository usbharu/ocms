package catalog

import (
	"context"
	"net/http"

	"github.com/jackc/pgx/v5"
	"ocms/internal/contracts"
	"ocms/internal/platform"
)

// Upload completion and state delivery take this lock before locking Asset
// rows, so a concurrent attachment observes the state or receives the update.
func lockBlobProcessingState(ctx context.Context, tx pgx.Tx, blob string) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended(($1::uuid)::text,3))`, blob)
	return err
}

func (s *Service) updateBlobProcessingState(w http.ResponseWriter, r *http.Request) {
	blob := r.PathValue("id")
	if !validID(blob) {
		platform.Error(w, 404, "NOT_FOUND")
		return
	}
	var in contracts.BlobProcessingState
	if !platform.Decode(w, r, &in) {
		return
	}
	if in.Revision <= 0 || (in.Status != "processing" && in.Status != "ready" && in.Status != "failed") {
		platform.Error(w, 400, "INVALID_REQUEST")
		return
	}
	if err := s.applyBlobProcessingState(r.Context(), blob, in); err != nil {
		platform.RespondError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Service) applyBlobProcessingState(ctx context.Context, blob string, in contracts.BlobProcessingState) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := lockBlobProcessingState(ctx, tx, blob); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `INSERT INTO catalog.blob_processing_states(blob_id,revision,status) VALUES($1,$2,$3)
		ON CONFLICT(blob_id) DO UPDATE SET revision=EXCLUDED.revision,status=EXCLUDED.status
		WHERE catalog.blob_processing_states.revision<EXCLUDED.revision`, blob, in.Revision, in.Status)
	if err != nil || tag.RowsAffected() == 0 {
		return err
	}
	ids, err := lockCharacterAssets(ctx, tx, blob)
	if err != nil {
		return err
	}
	if len(ids) > 0 {
		if _, err := tx.Exec(ctx, `UPDATE catalog.assets SET status=$2,updated_at=now()
			WHERE id=ANY($1::uuid[]) AND status IS DISTINCT FROM $2`, ids, in.Status); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, applyWD14Tags, blob); err != nil {
			return err
		}
		if err := applyBlobCharactersAndRating(ctx, tx, blob, ids); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func applyBlobMetadataToAsset(ctx context.Context, tx pgx.Tx, blob, asset string) error {
	if _, err := tx.Exec(ctx, applyWD14Tags+` AND a.id=$2`, blob, asset); err != nil {
		return err
	}
	return applyBlobCharactersAndRating(ctx, tx, blob, []string{asset})
}

func applyBlobCharactersAndRating(ctx context.Context, tx pgx.Tx, blob string, assets []string) error {
	if _, err := tx.Exec(ctx, applyWD14Characters, blob, assets); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, applyWD14Rating, blob, assets)
	return err
}
