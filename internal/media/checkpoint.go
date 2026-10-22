package media

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"math"

	"github.com/jackc/pgx/v5"
	"ocms/internal/contracts"
	"ocms/internal/platform"
)

type inferenceIdentity struct {
	Model    string `json:"model_id"`
	Revision string `json:"revision"`
	DType    string `json:"inference_dtype"`
}

func checkpointKey(identity inferenceIdentity, input any) (string, error) {
	raw, err := json.Marshal(struct {
		Identity inferenceIdentity
		Input    any
	}{identity, input})
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:]), nil
}
func validCheckpoint(value contracts.Embedding, identity inferenceIdentity) bool {
	if value.Model != identity.Model || value.Revision != identity.Revision || len(value.Vector) != 768 {
		return false
	}
	for _, x := range value.Vector {
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return false
		}
	}
	return true
}
func (s *Service) encodeCheckpoint(ctx context.Context, j contracts.Job, identity inferenceIdentity, input any) (contracts.Embedding, error) {
	var value contracts.Embedding
	key, err := checkpointKey(identity, input)
	if err != nil {
		return value, err
	}
	var raw []byte
	err = s.DB.QueryRow(ctx, `SELECT result FROM media.embedding_checkpoints WHERE job_id=$1 AND model_id=$2 AND model_revision=$3 AND input_sha256=$4`, j.ID, identity.Model, identity.Revision, key).Scan(&raw)
	if err == nil {
		if json.Unmarshal(raw, &value) != nil || !validCheckpoint(value, identity) {
			return value, processingError("INVALID_EMBEDDING_CHECKPOINT")
		}
		slog.InfoContext(ctx, "media.embedding_checkpoint_reused", "job_id", j.ID)
		return value, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return value, err
	}
	value, err = s.encode(ctx, input)
	if err != nil {
		return value, err
	}
	if !validCheckpoint(value, identity) {
		return value, processingError("INVALID_EMBEDDING")
	}
	raw, err = json.Marshal(value)
	if err != nil {
		return value, err
	}
	tag, err := s.DB.Exec(ctx, `INSERT INTO media.embedding_checkpoints(job_id,model_id,model_revision,input_sha256,result) SELECT id,$3,$4,$5,$6 FROM media.processing_jobs WHERE id=$1 AND lease_token=$2 AND status='running' AND locked_until>now() ON CONFLICT(job_id,model_id,model_revision,input_sha256) DO UPDATE SET result=excluded.result`, j.ID, j.Lease, identity.Model, identity.Revision, key, raw)
	if err == nil && tag.RowsAffected() == 0 {
		return value, processingError("LEASE_LOST")
	}
	if err == nil {
		slog.InfoContext(ctx, "media.embedding_checkpoint_saved", "job_id", j.ID)
	}
	return value, err
}
func (s *Service) inferenceIdentity(ctx context.Context) (inferenceIdentity, error) {
	var identity inferenceIdentity
	err := platform.Call(ctx, "GET", s.Runtime+"/healthz", "", nil, &identity)
	if err == nil && (identity.Model == "" || identity.Revision == "") {
		err = processingError("INVALID_INFERENCE_IDENTITY")
	}
	return identity, err
}
