package platform

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func Env(k, fallback string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return fallback
}
func DB(ctx context.Context) (*pgxpool.Pool, error) {
	return pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
}
func JSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func Error(w http.ResponseWriter, status int, code string) {
	JSON(w, status, map[string]string{"error": code})
}
func Decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if d.Decode(v) != nil {
		Error(w, 400, "INVALID_REQUEST")
		return false
	}
	if d.Decode(new(any)) != io.EOF {
		Error(w, 400, "INVALID_REQUEST")
		return false
	}
	return true
}
func Internal(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		expected := os.Getenv("INTERNAL_TOKEN")
		if len(expected) < 32 || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Service-Token")), []byte(expected)) != 1 {
			Error(w, 401, "AUTH_REQUIRED")
			return
		}
		w.Header().Set("Cache-Control", "private, no-store")
		next.ServeHTTP(w, r)
	})
}

var Client = &http.Client{Transport: SafeTransport{Base: http.DefaultTransport}, Timeout: 10 * time.Minute}

func Call(ctx context.Context, method, url, user string, input, output any) error {
	var body io.Reader
	if input != nil {
		b, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(b)
	}
	req, err := Request(ctx, method, url, body)
	if err != nil {
		return err
	}
	req.Header.Set("X-Service-Token", os.Getenv("INTERNAL_TOKEN"))
	req.Header.Set("X-Principal", user)
	req.Header.Set("Content-Type", "application/json")
	res, err := Client.Do(req)
	if err != nil {
		return errors.New("service unavailable")
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		return &HTTPError{Status: res.StatusCode}
	}
	if output != nil {
		return json.NewDecoder(res.Body).Decode(output)
	}
	return nil
}

type HTTPError struct{ Status int }

func (e *HTTPError) Error() string { return fmt.Sprintf("upstream status %d", e.Status) }
func RespondError(w http.ResponseWriter, err error) {
	var e *HTTPError
	if errors.As(err, &e) && (e.Status == 404 || e.Status == 403 || e.Status == 409) {
		Error(w, e.Status, map[int]string{404: "NOT_FOUND", 403: "FORBIDDEN", 409: "CONFLICT"}[e.Status])
		return
	}
	Error(w, 503, "SERVICE_UNAVAILABLE")
}
func Audit(ctx context.Context, event, user, id string) {
	slog.InfoContext(ctx, event, "principal_id", user, "asset_id", id, "outcome", "success")
}

type jobContextKey int

// WithJob propagates the live lease to trusted internal processing APIs.
func WithJob(ctx context.Context, id, lease string) context.Context {
	return context.WithValue(context.WithValue(ctx, jobContextKey(0), id), jobContextKey(1), lease)
}
func Request(ctx context.Context, method, url string, body io.Reader) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Service-Token", os.Getenv("INTERNAL_TOKEN"))
	if id, ok := ctx.Value(jobContextKey(0)).(string); ok {
		req.Header.Set("X-Job-ID", id)
	}
	if lease, ok := ctx.Value(jobContextKey(1)).(string); ok {
		req.Header.Set("X-Job-Lease", lease)
	}
	return req, nil
}
