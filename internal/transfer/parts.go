package transfer

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
	"ocms/internal/catalog"
	"ocms/internal/cryptostore"
	"ocms/internal/platform"
)

const uploadPartSize int64 = 8 << 20

type uploadPart struct {
	Ready                     bool   `json:"-"`
	Number                    int    `json:"part_number"`
	Size                      int64  `json:"size_bytes"`
	Key                       string `json:"-"`
	Hash                      []byte `json:"-"`
	KeyID                     string `json:"-"`
	Wrapped, WrapNonce, Nonce []byte `json:"-"`
}

func partLength(size int64, number int) (int64, error) {
	if number < 0 || size <= 0 || int64(number) > (size-1)/uploadPartSize {
		return 0, errors.New("invalid part")
	}
	remaining := size - int64(number)*uploadPartSize
	return min(remaining, uploadPartSize), nil
}

// All mutations and collection of one upload share a nonblocking session lock.
func (s *Service) lockParts(ctx context.Context, upload string) (*pgxpool.Conn, func(), error) {
	conn, err := s.DB.Acquire(ctx)
	if err != nil {
		return nil, nil, err
	}
	var locked bool
	err = conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtextextended($1,0))`, "parts:"+upload).Scan(&locked)
	if err != nil || !locked {
		conn.Release()
		if err == nil {
			err = &storeFailure{409, "UPLOAD_IN_PROGRESS"}
		}
		return nil, nil, err
	}
	return conn, func() {
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, e := conn.Exec(c, `SELECT pg_advisory_unlock(hashtextextended($1,0))`, "parts:"+upload); e != nil {
			_ = conn.Conn().Close(c)
		}
		conn.Release()
	}, nil
}

func loadParts(ctx context.Context, conn *pgxpool.Conn, upload string) ([]uploadPart, error) {
	rows, err := conn.Query(ctx, `SELECT part_number,size_bytes,object_key,sha256,master_key_id,encrypted_dek,dek_wrap_nonce,data_nonce,ready FROM storage.upload_parts WHERE upload_id=$1 ORDER BY part_number`, upload)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	parts := make([]uploadPart, 0)
	for rows.Next() {
		var p uploadPart
		if err := rows.Scan(&p.Number, &p.Size, &p.Key, &p.Hash, &p.KeyID, &p.Wrapped, &p.WrapNonce, &p.Nonce, &p.Ready); err != nil {
			return nil, err
		}
		parts = append(parts, p)
	}
	return parts, rows.Err()
}

func (s *Service) parts(w http.ResponseWriter, r *http.Request) {
	var u catalog.Upload
	if err := platform.Call(r.Context(), "GET", s.Catalog+"/api/v1/uploads/"+r.PathValue("id"), r.Header.Get("X-Principal"), nil, &u); err != nil {
		platform.RespondError(w, err)
		return
	}
	if u.Size < 0 || u.Size > s.MaxSize {
		platform.Error(w, 413, "UPLOAD_TOO_LARGE")
		return
	}
	conn, unlock, err := s.lockParts(r.Context(), u.ID)
	if err != nil {
		storeError(w, err)
		return
	}
	defer unlock()
	parts, err := loadParts(r.Context(), conn, u.ID)
	if err != nil {
		storeError(w, err)
		return
	}
	if r.Method == "GET" {
		received := make([]uploadPart, 0)
		for _, p := range parts {
			if p.Ready {
				received = append(received, p)
			}
		}
		parts = received
		platform.JSON(w, 200, map[string]any{"part_size": uploadPartSize, "parts": parts, "state": u.State})
		return
	}
	if u.State == "completed" {
		if r.Method == "POST" {
			s.complete(w, r, u, *u.BlobID)
		} else {
			platform.Error(w, 409, "UPLOAD_COMPLETED")
		}
		return
	}
	if r.Method == "POST" {
		if !validParts(parts, u.Size) {
			platform.Error(w, 409, "UPLOAD_INCOMPLETE")
			return
		}
		reader := &partsReader{ctx: r.Context(), service: s, parts: parts, uploadID: u.ID}
		blob, err := s.storeWithConn(r.Context(), conn, reader, u.Size, u.ID)
		if err != nil {
			storeError(w, err)
			return
		}
		// Keep parts until Catalog confirms completion; retries reuse the stored Blob.
		if err := platform.Call(r.Context(), "POST", s.Catalog+"/internal/uploads/"+u.ID+"/complete", r.Header.Get("X-Principal"), map[string]string{"blob_id": blob}, nil); err != nil {
			platform.RespondError(w, err)
			return
		}
		s.removeParts(r.Context(), conn, u.ID, parts)
		platform.Audit(r.Context(), "transfer.stored", r.Header.Get("X-Principal"), u.AssetID)
		platform.JSON(w, 200, map[string]string{"upload_id": u.ID, "asset_id": u.AssetID, "state": "completed"})
		return
	}
	number, err := strconv.Atoi(r.PathValue("part"))
	if err != nil {
		platform.Error(w, 400, "INVALID_PART")
		return
	}
	size, err := partLength(u.Size, number)
	if err != nil || (r.ContentLength >= 0 && r.ContentLength != size) {
		platform.Error(w, 400, "SIZE_MISMATCH")
		return
	}
	plain, err := io.ReadAll(io.LimitReader(r.Body, size+1))
	if err != nil || int64(len(plain)) != size {
		platform.Error(w, 400, "SIZE_MISMATCH")
		return
	}
	hash := sha256.Sum256(plain)
	for _, p := range parts {
		if p.Number == number {
			if !p.Ready {
				s.removeParts(r.Context(), conn, u.ID, []uploadPart{p})
				break
			}
			if !bytes.Equal(p.Hash, hash[:]) {
				platform.Error(w, 409, "PART_MISMATCH")
				return
			}
			platform.JSON(w, 200, map[string]int{"part_number": number})
			return
		}
	}
	p := uploadPart{Number: number, Size: size, Key: "upload-parts/" + id(), Hash: hash[:]}
	dek := cryptostore.Random(32)
	p.KeyID, p.Wrapped, p.WrapNonce, err = s.Keys.Wrap(p.Key, dek)
	if err != nil {
		platform.Error(w, 503, "CRYPTO_UNAVAILABLE")
		return
	}
	block, _ := aes.NewCipher(dek)
	gcm, _ := cipher.NewGCM(block)
	p.Nonce = cryptostore.Random(gcm.NonceSize())
	encrypted := gcm.Seal(nil, p.Nonce, plain, []byte(fmt.Sprintf("%s:%d", u.ID, number)))
	// Register before S3 I/O so collection can recover interrupted writes.
	_, err = conn.Exec(r.Context(), `INSERT INTO storage.upload_parts(upload_id,part_number,object_key,size_bytes,sha256,master_key_id,encrypted_dek,dek_wrap_nonce,data_nonce) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, u.ID, number, p.Key, size, p.Hash, p.KeyID, p.Wrapped, p.WrapNonce, p.Nonce)
	if err == nil {
		_, err = s.S3.PutObject(r.Context(), s.Bucket, p.Key, bytes.NewReader(encrypted), int64(len(encrypted)), minio.PutObjectOptions{ContentType: "application/octet-stream"})
	}
	if err == nil {
		_, err = conn.Exec(r.Context(), `UPDATE storage.upload_parts SET ready=true WHERE upload_id=$1 AND part_number=$2`, u.ID, number)
	}
	if err != nil {
		// An uncertain S3 result must not make an incomplete part appear received.
		// Retain its intent for GC, but allow the same part to be uploaded again.
		s.removeParts(r.Context(), conn, u.ID, []uploadPart{p})
		platform.Error(w, 503, "UPLOAD_FAILED")
		return
	}
	platform.JSON(w, 200, map[string]int{"part_number": number})
}

func validParts(parts []uploadPart, size int64) bool {
	if size == 0 {
		return len(parts) == 0
	}
	if int64(len(parts)) != (size-1)/uploadPartSize+1 {
		return false
	}
	for i, p := range parts {
		n, err := partLength(size, i)
		if err != nil || !p.Ready || p.Number != i || p.Size != n {
			return false
		}
	}
	return true
}

type partsReader struct {
	ctx      context.Context
	service  *Service
	parts    []uploadPart
	current  *bytes.Reader
	uploadID string
}

func (r *partsReader) Read(dst []byte) (int, error) {
	for r.current == nil || r.current.Len() == 0 {
		if len(r.parts) == 0 {
			return 0, io.EOF
		}
		p := r.parts[0]
		r.parts = r.parts[1:]
		obj, err := r.service.S3.GetObject(r.ctx, r.service.Bucket, p.Key, minio.GetObjectOptions{})
		if err != nil {
			return 0, err
		}
		encrypted, err := io.ReadAll(io.LimitReader(obj, p.Size+17))
		_ = obj.Close()
		if err != nil {
			return 0, err
		}
		dek, err := r.service.Keys.Unwrap(p.Key, p.KeyID, p.Wrapped, p.WrapNonce)
		if err != nil {
			return 0, err
		}
		block, err := aes.NewCipher(dek)
		if err != nil {
			return 0, err
		}
		gcm, err := cipher.NewGCM(block)
		if err != nil {
			return 0, err
		}
		if len(p.Nonce) != gcm.NonceSize() {
			return 0, errors.New("invalid part nonce")
		}
		// Bind ciphertext to both the session and part number.
		plain, err := gcm.Open(nil, p.Nonce, encrypted, []byte(fmt.Sprintf("%s:%d", r.uploadID, p.Number)))
		if err != nil {
			return 0, err
		}
		r.current = bytes.NewReader(plain)
	}
	return r.current.Read(dst)
}

func (s *Service) removeParts(ctx context.Context, conn *pgxpool.Conn, upload string, parts []uploadPart) {
	for _, p := range parts {
		if err := s.S3.RemoveObject(ctx, s.Bucket, p.Key, minio.RemoveObjectOptions{}); err != nil {
			continue
		}
		_, _ = conn.Exec(ctx, `DELETE FROM storage.upload_parts WHERE upload_id=$1 AND part_number=$2 AND object_key=$3`, upload, p.Number, p.Key)
	}
}

func (s *Service) reconcileParts(ctx context.Context) error {
	rows, err := s.DB.Query(ctx, `SELECT DISTINCT upload_id::text FROM storage.upload_parts WHERE created_at < now()-interval '25 hours'`)
	if err != nil {
		return err
	}
	var uploads []string
	for rows.Next() {
		var u string
		if err := rows.Scan(&u); err != nil {
			rows.Close()
			return err
		}
		uploads = append(uploads, u)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, u := range uploads {
		conn, unlock, err := s.lockParts(ctx, u)
		if err != nil {
			var failure *storeFailure
			if errors.As(err, &failure) {
				continue
			}
			return err
		}
		parts, e := loadParts(ctx, conn, u)
		if e == nil {
			s.removeParts(ctx, conn, u, parts)
		}
		unlock()
		if e != nil {
			return e
		}
	}
	return nil
}

func (s *Service) rewrapParts(ctx context.Context) error {
	for {
		tx, err := s.DB.Begin(ctx)
		if err != nil {
			return err
		}
		var p uploadPart
		err = tx.QueryRow(ctx, `SELECT object_key,master_key_id,encrypted_dek,dek_wrap_nonce FROM storage.upload_parts WHERE master_key_id<>$1 LIMIT 1 FOR UPDATE`, s.Keys.Active).Scan(&p.Key, &p.KeyID, &p.Wrapped, &p.WrapNonce)
		if errors.Is(err, pgx.ErrNoRows) {
			_ = tx.Rollback(ctx)
			return nil
		}
		if err == nil {
			var dek []byte
			dek, err = s.Keys.Unwrap(p.Key, p.KeyID, p.Wrapped, p.WrapNonce)
			if err == nil {
				p.KeyID, p.Wrapped, p.WrapNonce, err = s.Keys.Wrap(p.Key, dek)
			}
			if err == nil {
				_, err = tx.Exec(ctx, `UPDATE storage.upload_parts SET master_key_id=$2,encrypted_dek=$3,dek_wrap_nonce=$4 WHERE object_key=$1`, p.Key, p.KeyID, p.Wrapped, p.WrapNonce)
			}
		}
		if err == nil {
			err = tx.Commit(ctx)
		} else {
			_ = tx.Rollback(ctx)
		}
		if err != nil {
			return err
		}
	}
}
