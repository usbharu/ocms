package transfer

import (
	"bufio"
	"context"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"ocms/internal/catalog"
	"ocms/internal/cryptostore"
	"ocms/internal/platform"
)

type Service struct {
	DB              *pgxpool.Pool
	S3              *minio.Client
	Keys            *cryptostore.Keyring
	Bucket, Catalog string
	MaxSize         int64
}

func New(ctx context.Context, db *pgxpool.Pool, max int64) (*Service, error) {
	keys, err := cryptostore.Load(os.Getenv("CRYPTO_CONFIG"))
	if err != nil {
		return nil, err
	}
	client, err := minio.New(os.Getenv("S3_ENDPOINT"), &minio.Options{Creds: credentials.NewStaticV4(os.Getenv("S3_ACCESS_KEY"), os.Getenv("S3_SECRET_KEY"), ""), MaxRetries: 3, Secure: platform.Env("S3_TLS", "false") == "true"})
	if err != nil {
		return nil, errors.New("invalid S3 configuration")
	}
	bucket := platform.Env("S3_BUCKET", "media")
	exists, err := client.BucketExists(ctx, bucket)
	if err != nil {
		return nil, errors.New("S3 unavailable")
	}
	if !exists {
		if err = client.MakeBucket(ctx, bucket, minio.MakeBucketOptions{}); err != nil {
			return nil, errors.New("cannot create S3 bucket")
		}
	}
	return &Service{DB: db, S3: client, Keys: keys, Bucket: bucket, Catalog: os.Getenv("CATALOG_URL"), MaxSize: max}, nil
}
func (s *Service) Handler() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("PUT /api/v1/uploads/{id}/content", s.upload)
	m.HandleFunc("GET /api/v1/uploads/{id}/parts", s.parts)
	m.HandleFunc("PUT /api/v1/uploads/{id}/parts/{part}", s.parts)
	m.HandleFunc("POST /api/v1/uploads/{id}/complete", s.parts)
	m.HandleFunc("GET /internal/blobs/{id}/content", s.workerRead)
	m.HandleFunc("POST /internal/blobs/{id}/derivatives", s.derivative)
	m.HandleFunc("GET /api/v1/assets/{id}/preview", s.preview)
	m.HandleFunc("GET /api/v1/assets/{id}/renditions/{rendition}/content", s.rendition)
	m.HandleFunc("HEAD /api/v1/assets/{id}/renditions/{rendition}/content", s.rendition)
	m.HandleFunc("GET /api/v1/assets/{id}/content", s.download)
	m.HandleFunc("HEAD /api/v1/assets/{id}/content", s.download)
	return platform.Internal(m)
}
func id() string {
	b := cryptostore.Random(16)
	b[6] = b[6]&15 | 64
	b[8] = b[8]&63 | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func (s *Service) upload(w http.ResponseWriter, r *http.Request) {
	var u catalog.Upload
	principal := r.Header.Get("X-Principal")
	if err := platform.Call(r.Context(), "GET", s.Catalog+"/api/v1/uploads/"+r.PathValue("id"), principal, nil, &u); err != nil {
		platform.RespondError(w, err)
		return
	}
	if r.ContentLength >= 0 && r.ContentLength != u.Size {
		platform.Error(w, 400, "SIZE_MISMATCH")
		return
	}
	blob, err := s.store(r.Context(), r.Body, u.Size, u.ID)
	if err != nil {
		storeError(w, err)
		return
	}
	platform.Audit(r.Context(), "transfer.stored", principal, u.AssetID)
	s.complete(w, r, u, blob)
}
func (s *Service) complete(w http.ResponseWriter, r *http.Request, u catalog.Upload, blob string) {
	err := platform.Call(r.Context(), "POST", s.Catalog+"/internal/uploads/"+u.ID+"/complete", r.Header.Get("X-Principal"), map[string]string{"blob_id": blob}, nil)
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	platform.JSON(w, 200, map[string]string{"upload_id": u.ID, "asset_id": u.AssetID, "state": "completed"})
}

// ParseRange supports a single byte range. Multipart ranges are ignored per §5.5.
func ParseRange(value string, size int64) (start, end int64, partial bool, err error) {
	if value == "" || strings.Contains(value, ",") {
		return 0, size - 1, false, nil
	}
	if !strings.HasPrefix(value, "bytes=") {
		return 0, size - 1, false, nil
	}
	parts := strings.Split(strings.TrimPrefix(value, "bytes="), "-")
	bad := errors.New("invalid range")
	if len(parts) != 2 || size == 0 {
		return 0, 0, false, bad
	}
	parse := func(v string) (int64, error) {
		if v == "" {
			return 0, bad
		}
		for _, c := range v {
			if c < '0' || c > '9' {
				return 0, bad
			}
		}
		return strconv.ParseInt(v, 10, 64)
	}
	if parts[0] == "" {
		n, e := parse(parts[1])
		if e != nil || n <= 0 {
			return 0, 0, false, bad
		}
		if n > size {
			n = size
		}
		return size - n, size - 1, true, nil
	}
	start, err = parse(parts[0])
	if err != nil || start >= size {
		return 0, 0, false, bad
	}
	end = size - 1
	if parts[1] != "" {
		end, err = parse(parts[1])
		if err != nil || end < start {
			return 0, 0, false, bad
		}
		if end >= size {
			end = size - 1
		}
	}
	return start, end, true, nil
}
func (s *Service) download(w http.ResponseWriter, r *http.Request) {
	principal := r.Header.Get("X-Principal")
	var a catalog.Asset
	if err := platform.Call(r.Context(), "GET", s.Catalog+"/api/v1/assets/"+r.PathValue("id"), principal, nil, &a); err != nil {
		platform.RespondError(w, err)
		return
	}
	if a.BlobID == nil {
		platform.Error(w, 409, "INDEX_PENDING")
		return
	}
	s.serveBlob(w, r, a, principal)
}
func (s *Service) serveBlob(w http.ResponseWriter, r *http.Request, a catalog.Asset, principal string) {
	ctx, endSpan := platform.Span(r.Context(), "transfer.decrypt_range")
	defer endSpan()
	r = r.WithContext(ctx)
	var size int64
	var bucket, key, keyID string
	var wrapped, nonce, prefix, sha []byte
	err := s.DB.QueryRow(r.Context(), `SELECT size_bytes,bucket,object_key,master_key_id,encrypted_dek,dek_wrap_nonce,ctr_nonce_prefix,sha256 FROM storage.blobs WHERE id=$1 AND status='ready'`, *a.BlobID).Scan(&size, &bucket, &key, &keyID, &wrapped, &nonce, &prefix, &sha)
	if err != nil {
		platform.RespondError(w, err)
		return
	}
	etag := `"` + hex.EncodeToString(sha) + `"`
	value := r.Header.Get("Range")
	if v := r.Header.Get("If-Range"); v != "" && v != etag {
		value = ""
	}
	if r.Method == "HEAD" {
		value = ""
	}
	start, end, partial, err := ParseRange(value, size)
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("ETag", etag)
	if err != nil {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", size))
		platform.Error(w, 416, "RANGE_NOT_SATISFIABLE")
		return
	}
	length := size
	if partial {
		length = end - start + 1
	}
	if r.Method == "HEAD" {
		w.Header().Set("Content-Type", a.MIME)
		w.Header().Set("Content-Length", strconv.FormatInt(length, 10))
		return
	}
	dek, err := s.Keys.Unwrap(*a.BlobID, keyID, wrapped, nonce)
	if err != nil {
		platform.Error(w, 503, "CRYPTO_UNAVAILABLE")
		return
	}
	stream, err := cryptostore.Stream(dek, prefix, start)
	if err != nil {
		platform.Error(w, 503, "CRYPTO_UNAVAILABLE")
		return
	}
	platform.Audit(r.Context(), "crypto.dek_unwrapped", principal, a.ID)
	var object *minio.Object
	var source io.Reader
	if length > 0 {
		opts := minio.GetObjectOptions{}
		if partial {
			_ = opts.SetRange(start, end)
		}
		object, err = s.S3.GetObject(r.Context(), bucket, key, opts)
		if err == nil {
			buffered := bufio.NewReader(object)
			_, err = buffered.Peek(1)
			source = buffered
		}
		if err != nil {
			if object != nil {
				object.Close()
			}
			platform.Error(w, 503, "STORAGE_UNAVAILABLE")
			return
		}
		defer object.Close()
	}
	w.Header().Set("Content-Type", a.MIME)
	w.Header().Set("Content-Length", strconv.FormatInt(length, 10))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if partial {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, size))
		w.WriteHeader(206)
	}
	if length > 0 {
		_, err = io.CopyN(w, &cipher.StreamReader{S: stream, R: source}, length)
		if err != nil {
			slog.WarnContext(r.Context(), "transfer.download_interrupted", "asset_id", a.ID)
			return
		}
	}
	platform.Count(r.Context(), "media.download.bytes", length)
	platform.Count(r.Context(), "media.crypto.bytes", length)
	platform.Audit(r.Context(), "asset.downloaded", principal, a.ID)
}
func (s *Service) cleanupObject(ctx context.Context, db interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}, intent, key string) {
	if err := s.S3.RemoveObject(ctx, s.Bucket, key, minio.RemoveObjectOptions{}); err != nil {
		slog.WarnContext(ctx, "transfer.cleanup_retry", "intent_id", intent)
		return
	}
	if _, err := db.Exec(ctx, `DELETE FROM storage.upload_objects WHERE id=$1 AND state IN ('writing','duplicate')`, intent); err != nil {
		slog.WarnContext(ctx, "transfer.cleanup_retry", "intent_id", intent)
	}
}

// Reconcile only abandoned write intents; referenced/committed Blobs are never collected.
func (s *Service) Reconcile(ctx context.Context) error {
	if err := s.reconcileParts(ctx); err != nil {
		return err
	}
	rows, err := s.DB.Query(ctx, `SELECT id,upload_id,object_key FROM storage.upload_objects WHERE state IN ('writing','duplicate') AND created_at<now()-interval '1 hour'`)
	if err != nil {
		return err
	}
	type item struct{ id, upload, key string }
	var items []item
	for rows.Next() {
		var i item
		if err = rows.Scan(&i.id, &i.upload, &i.key); err != nil {
			break
		}
		items = append(items, i)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return err
	}
	for _, i := range items {
		conn, e := s.DB.Acquire(ctx)
		if e != nil {
			return e
		}
		var locked bool
		e = conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtextextended($1,0))`, i.upload).Scan(&locked)
		if e == nil && locked {
			var safe bool
			e = conn.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM storage.upload_objects u WHERE u.id=$1 AND u.state IN ('writing','duplicate') AND NOT EXISTS(SELECT 1 FROM storage.blobs b WHERE b.object_key=u.object_key))`, i.id).Scan(&safe)
			if e == nil && safe {
				s.cleanupObject(ctx, conn, i.id, i.key)
			}
			if _, e = conn.Exec(ctx, `SELECT pg_advisory_unlock(hashtextextended($1,0))`, i.upload); e != nil {
				_ = conn.Conn().Close(context.Background())
			}
		}
		conn.Release()
	}
	return nil
}

// Rewrap changes only envelope metadata, under a row lock, never the S3 object.
func (s *Service) Rewrap(ctx context.Context) error {
	for {
		tx, err := s.DB.Begin(ctx)
		if err != nil {
			return err
		}
		var blob, keyID string
		var wrapped, nonce []byte
		err = tx.QueryRow(ctx, `SELECT id,master_key_id,encrypted_dek,dek_wrap_nonce FROM storage.blobs WHERE master_key_id<>$1 LIMIT 1 FOR UPDATE`, s.Keys.Active).Scan(&blob, &keyID, &wrapped, &nonce)
		if errors.Is(err, pgx.ErrNoRows) {
			tx.Rollback(ctx)
			return s.rewrapParts(ctx)
		}
		if err != nil {
			tx.Rollback(ctx)
			return err
		}
		dek, err := s.Keys.Unwrap(blob, keyID, wrapped, nonce)
		if err != nil {
			tx.Rollback(ctx)
			return err
		}
		keyID, wrapped, nonce, err = s.Keys.Wrap(blob, dek)
		if err == nil {
			_, err = tx.Exec(ctx, `UPDATE storage.blobs SET master_key_id=$2,encrypted_dek=$3,dek_wrap_nonce=$4 WHERE id=$1`, blob, keyID, wrapped, nonce)
		}
		if err == nil {
			err = tx.Commit(ctx)
		} else {
			tx.Rollback(ctx)
		}
		if err != nil {
			return err
		}
	}
}

// CiphertextInfo is a local diagnostic for verifying the persisted envelope format.
// It returns only the ciphertext length and digest, never keys or plaintext.
func (s *Service) CiphertextInfo(ctx context.Context, blob string) (int64, string, error) {
	var bucket, key string
	if err := s.DB.QueryRow(ctx, `SELECT bucket,object_key FROM storage.blobs WHERE id=$1`, blob).Scan(&bucket, &key); err != nil {
		return 0, "", err
	}
	object, err := s.S3.GetObject(ctx, bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return 0, "", err
	}
	defer object.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, object)
	return size, hex.EncodeToString(hash.Sum(nil)), err
}
