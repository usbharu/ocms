package transfer

import (
	"context"
	"crypto/cipher"
	"crypto/sha256"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
	"ocms/internal/cryptostore"
	"ocms/internal/platform"
)

type storeFailure struct {
	status int
	code   string
}

func (e *storeFailure) Error() string { return e.code }
func storeError(w http.ResponseWriter, err error) {
	var e *storeFailure
	if errors.As(err, &e) {
		platform.Error(w, e.status, e.code)
		return
	}
	slog.Warn("transfer.store_failed", "stage", "database")
	platform.RespondError(w, err)
}

// store is used by originals and derivatives. A stable operation ID recovers an
// uncertain DB commit without deleting possibly committed S3 objects.
func (s *Service) store(ctx context.Context, body io.Reader, size int64, operation string) (string, error) {
	conn, err := s.DB.Acquire(ctx)
	if err != nil {
		return "", err
	}
	defer conn.Release()
	return s.storeWithConn(ctx, conn, body, size, operation)
}

func (s *Service) storeWithConn(ctx context.Context, conn *pgxpool.Conn, body io.Reader, size int64, operation string) (string, error) {
	ctx, end := platform.Span(ctx, "transfer.encrypt_stream")
	defer end()
	started := time.Now()
	defer platform.Duration(ctx, "media.upload.duration", started)
	if size < 0 || size > s.MaxSize {
		return "", &storeFailure{413, "UPLOAD_TOO_LARGE"}
	}
	var err error
	var locked bool
	if err = conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtextextended($1,0))`, operation).Scan(&locked); err != nil {
		return "", err
	}
	if !locked {
		return "", &storeFailure{409, "UPLOAD_IN_PROGRESS"}
	}
	defer func() {
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, e := conn.Exec(c, `SELECT pg_advisory_unlock(hashtextextended($1,0))`, operation); e != nil {
			_ = conn.Conn().Close(c)
		}
	}()
	var existing string
	err = conn.QueryRow(ctx, `SELECT blob_id FROM storage.upload_objects WHERE upload_id=$1 AND state='stored'`, operation).Scan(&existing)
	if err == nil {
		return existing, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	blob := id()
	objectKey := "blobs/" + blob
	if _, err = conn.Exec(ctx, `INSERT INTO storage.upload_objects(id,upload_id,object_key,state) VALUES($1,$2,$3,'writing')`, blob, operation, objectKey); err != nil {
		return "", err
	}
	dek, prefix := cryptostore.Random(32), cryptostore.Random(8)
	keyID, wrapped, nonce, err := s.Keys.Wrap(blob, dek)
	if err != nil {
		return "", &storeFailure{503, "CRYPTO_UNAVAILABLE"}
	}
	stream, err := cryptostore.Stream(dek, prefix, 0)
	if err != nil {
		return "", err
	}
	hash := sha256.New()
	reader := io.TeeReader(io.LimitReader(body, size+1), hash)
	s3ctx, s3end := platform.Span(ctx, "transfer.s3_upload")
	info, err := s.S3.PutObject(s3ctx, s.Bucket, objectKey, &cipher.StreamReader{S: stream, R: reader}, -1, minio.PutObjectOptions{ContentType: "application/octet-stream", PartSize: 5 << 20, NumThreads: 1})
	s3end()
	if err != nil {
		slog.WarnContext(ctx, "transfer.upload_failed", "stage", "s3")
		return "", &storeFailure{503, "UPLOAD_FAILED"}
	}
	if info.Size != size {
		return "", &storeFailure{400, "SIZE_MISMATCH"}
	}
	platform.Count(ctx, "media.upload.bytes", size)
	platform.Count(ctx, "media.crypto.bytes", size)
	ctx, dedupEnd := platform.Span(ctx, "transfer.deduplicate")
	defer dedupEnd()
	tx, err := conn.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	var winner string
	err = tx.QueryRow(ctx, `INSERT INTO storage.blobs(id,sha256,size_bytes,bucket,object_key,master_key_id,encrypted_dek,dek_wrap_nonce,ctr_nonce_prefix) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(sha256,size_bytes) DO NOTHING RETURNING id`, blob, hash.Sum(nil), size, s.Bucket, objectKey, keyID, wrapped, nonce, prefix).Scan(&winner)
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx, `SELECT id FROM storage.blobs WHERE sha256=$1 AND size_bytes=$2 AND status='ready'`, hash.Sum(nil), size).Scan(&winner)
	}
	if err != nil {
		return "", err
	}
	if winner == blob {
		_, err = tx.Exec(ctx, `UPDATE storage.upload_objects SET state='stored',blob_id=$2 WHERE id=$1`, blob, winner)
	} else {
		_, err = tx.Exec(ctx, `UPDATE storage.upload_objects SET state='duplicate' WHERE id=$1`, blob)
		if err == nil {
			_, err = tx.Exec(ctx, `INSERT INTO storage.upload_objects(id,upload_id,object_key,blob_id,state) VALUES($1,$2,$3,$4,'stored')`, id(), operation, "reference/"+blob, winner)
		}
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		return "", err
	}
	if winner != blob {
		platform.Count(ctx, "media.dedup.hits", 1)
		platform.Count(ctx, "media.dedup.saved_bytes", size)
		s.cleanupObject(ctx, conn, blob, objectKey)
	}
	return winner, nil
}
func derivativeOperation(source, profile string) string {
	h := sha256.Sum256([]byte("derivative:v1:" + source + ":" + profile))
	// UUID representation is only a stable operation identifier, not a cipher nonce.
	return stringID(h[:16])
}
