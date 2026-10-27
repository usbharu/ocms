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

func TestRecommendationsUseSearchAndSessionPrincipal(t *testing.T) {
	t.Setenv("AUTH_MODE", "development")
	t.Setenv("PUBLIC_URL", "http://localhost:8080")
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if (r.URL.Path != "/api/v1/assets/source/recommendations" && r.URL.Path != "/api/v1/recommendations") || r.Header.Get("X-Principal") != "reader" || r.Header.Get("Cookie") != "" {
			t.Error("recommendation proxy did not enforce session boundary")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"assets":[]}`))
	}))
	defer upstream.Close()
	t.Setenv("SEARCH_URL", upstream.URL)
	t.Setenv("CATALOG_URL", "http://127.0.0.1:1")
	s, err := New(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	s.sessions["session"] = session{Principal: "reader", Expiry: time.Now().Add(time.Hour)}
	for _, path := range []string{"/api/v1/assets/source/recommendations", "/api/v1/recommendations"} {
		for _, authenticated := range []bool{false, true} {
			req := httptest.NewRequest("GET", path, nil)
			req.Header.Set("X-Principal", "forged")
			if authenticated {
				req.AddCookie(&http.Cookie{Name: "ocms_session", Value: "session"})
			}
			response := httptest.NewRecorder()
			s.Handler(fstest.MapFS{}).ServeHTTP(response, req)
			expected := 401
			if authenticated {
				expected = 200
			}
			if response.Code != expected {
				t.Fatalf("status %d, expected %d", response.Code, expected)
			}
		}
	}
	if calls != 2 {
		t.Fatal("anonymous request reached Search")
	}
}

func TestMediaCachingPreservesSessionBoundary(t *testing.T) {
	t.Setenv("AUTH_MODE", "development")
	t.Setenv("PUBLIC_URL", "http://localhost:8080")
	status := 200
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Cookie") != "" || r.Header.Get("X-Principal") != "reader" || r.Header.Get("If-None-Match") != `"cached"` {
			t.Error("media proxy lost authorization or validator boundary")
		}
		w.Header().Set("Cache-Control", "private, no-cache")
		w.Header().Set("ETag", `"cached"`)
		w.WriteHeader(status)
	}))
	defer upstream.Close()
	t.Setenv("TRANSFER_URL", upstream.URL)
	s, err := New(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	s.sessions["session"] = session{Principal: "reader", Expiry: time.Now().Add(time.Hour)}
	s.sessions["expired"] = session{Principal: "reader", Expiry: time.Now().Add(-time.Hour)}
	handler := s.Handler(fstest.MapFS{})
	for _, path := range []string{"/api/v1/assets/a/content", "/api/v1/assets/a/preview?page=2", "/api/v1/assets/a/renditions/r/content"} {
		for _, code := range []int{200, 206, 304, 404, 503} {
			status = code
			r := httptest.NewRequest("GET", path, nil)
			r.AddCookie(&http.Cookie{Name: "ocms_session", Value: "session"})
			r.Header.Set("If-None-Match", `"cached"`)
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			policy := "private, no-cache"
			if code >= 400 {
				policy = "private, no-store"
			}
			if w.Code != code || len(w.Header().Values("Cache-Control")) != 1 || w.Header().Get("Cache-Control") != policy {
				t.Fatalf("unexpected media response: %d %v", w.Code, w.Header())
			}
			if code < 400 && w.Header().Get("Vary") != "Cookie" {
				t.Fatal("media cache must vary by session cookie")
			}
		}
	}
	before := calls
	for _, cookie := range []string{"", "expired"} {
		r := httptest.NewRequest("GET", "/api/v1/assets/a/content", nil)
		r.Header.Set("If-None-Match", `"cached"`)
		r.AddCookie(&http.Cookie{Name: "ocms_session", Value: cookie})
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != 401 || w.Header().Get("Cache-Control") != "private, no-store" {
			t.Fatal("cached validator bypassed session authentication")
		}
	}
	if calls != before {
		t.Fatal("unauthenticated revalidation reached Transfer")
	}
}
