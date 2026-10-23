package bff

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func TestDevelopmentAuthenticationRequiresLocalhost(t *testing.T) {
	t.Setenv("AUTH_MODE", "development")
	t.Setenv("PUBLIC_URL", "https://example.com")
	if _, err := New(context.Background()); err == nil {
		t.Fatal("public development auth accepted")
	}
}
func TestAuthAndCSRFBoundary(t *testing.T) {
	t.Setenv("AUTH_MODE", "development")
	t.Setenv("PUBLIC_URL", "http://localhost:8080")
	s, err := New(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	s.sessions["session"] = session{Principal: "authenticated", CSRF: "csrf", Expiry: time.Now().Add(time.Hour)}
	for _, tc := range []struct {
		method, path, cookie, origin, csrf string
		status                             int
	}{
		{"GET", "/api/v1/me", "", "", "", 401},
		{"GET", "/api/v1/me", "session", "", "", 200},
		{"POST", "/auth/logout", "session", "http://localhost:8080", "", 403},
		{"POST", "/auth/logout", "session", "https://evil.example", "csrf", 403},
		{"POST", "/auth/logout", "session", "http://localhost:8080", "csrf", 204},
		{"GET", "/api/v1/me", "session", "", "", 401},
	} {
		r := httptest.NewRequest(tc.method, tc.path, nil)
		r.Header.Set("X-Principal", "forged")
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("X-CSRF-Token", tc.csrf)
		if tc.cookie != "" {
			r.AddCookie(&http.Cookie{Name: "ocms_session", Value: tc.cookie})
		}
		w := httptest.NewRecorder()
		s.Handler(fstest.MapFS{}).ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Fatalf("%s %s got %d", tc.method, tc.path, w.Code)
		}
		if strings.Contains(w.Body.String(), "forged") {
			t.Fatal("external identity trusted")
		}
	}
}

func TestViewerContentSecurityPolicy(t *testing.T) {
	t.Setenv("AUTH_MODE", "development")
	t.Setenv("PUBLIC_URL", "http://localhost:8080")
	service, err := New(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	service.Handler(fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("test")}}).ServeHTTP(response, httptest.NewRequest("GET", "/", nil))
	policy := response.Header().Get("Content-Security-Policy")
	for _, directive := range []string{"default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "font-src 'self' blob:", "object-src 'none'", "frame-ancestors 'none'"} {
		if !strings.Contains(policy, directive) {
			t.Errorf("missing CSP directive %q", directive)
		}
	}
	if strings.Contains(policy, "'unsafe-eval'") || strings.Contains(policy, "'unsafe-inline'") {
		t.Fatal("viewer must not enable inline script or JavaScript eval")
	}
}
