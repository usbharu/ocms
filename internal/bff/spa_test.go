package bff

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-jose/go-jose/v4"
	"golang.org/x/oauth2"
)

func TestSPARoutesAndStaticBoundaries(t *testing.T) {
	t.Setenv("AUTH_MODE", "development")
	t.Setenv("PUBLIC_URL", "http://localhost:8080")
	service, err := New(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	handler := service.Handler(fstest.MapFS{
		"index.html":            &fstest.MapFile{Data: []byte("<html>application</html>")},
		"assets/app.js":         &fstest.MapFile{Data: []byte("javascript")},
		"pdfjs/cmaps/map.bcmap": &fstest.MapFile{Data: []byte("font")},
	})
	for _, tc := range []struct {
		path   string
		status int
		html   bool
	}{
		{"/", 200, true}, {"/library?q=sample&page=2", 200, true}, {"/tags", 200, true},
		{"/characters", 200, true}, {"/favorites", 200, true}, {"/recommendations", 200, true},
		{"/assets/id", 200, true}, {"/assets/id/view?from=favorites", 200, true},
		{"/unknown", 404, true}, {"/unknown/nested", 404, true},
		{"/assets/app.js", 200, false}, {"/pdfjs/cmaps/map.bcmap", 200, false},
		{"/assets/missing.js", 404, false}, {"/pdfjs/missing", 404, false},
		{"/auth/missing", 404, false}, {"/api", 404, false}, {"/api/v1/missing", 401, false},
	} {
		for _, method := range []string{"GET", "HEAD"} {
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, httptest.NewRequest(method, tc.path, nil))
			if w.Code != tc.status {
				t.Errorf("%s %s status %d", method, tc.path, w.Code)
			}
			if got := strings.HasPrefix(w.Header().Get("Content-Type"), "text/html"); got != tc.html {
				t.Errorf("%s %s HTML %v", method, tc.path, got)
			}
			if method == "HEAD" && tc.html && w.Body.Len() != 0 {
				t.Errorf("HEAD %s included body", tc.path)
			}
			if w.Header().Get("Content-Security-Policy") == "" {
				t.Error("CSP missing")
			}
		}
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("POST", "/library", nil))
	if w.Code != 405 {
		t.Fatal("SPA accepted mutation")
	}
}

func TestReturnTargets(t *testing.T) {
	for _, raw := range []string{"", "/", "/library?q=sample", "/tags?view=graph", "/assets/id/view?from=favorites&page=2"} {
		if target, ok := returnTarget(raw); !ok || target == "" {
			t.Error("valid return target rejected")
		}
	}
	for _, raw := range []string{"https://example.com/library", "//example.com/library", "/\\evil", "/%5cevil", "/library\n", "/assets/%00", "/auth/login", "/api/v1/me", "/unknown", "/library#fragment", "/assets/../library", "/assets/%2f%2fevil"} {
		if _, ok := returnTarget(raw); ok {
			t.Error("invalid return target accepted")
		}
	}
}

func TestLoginStoresReturnTargetInFlow(t *testing.T) {
	service := &Service{sessions: map[string]session{}, flows: map[string]flow{}}
	target := "/assets/id/view?from=favorites&page=2"
	w := httptest.NewRecorder()
	service.Handler(fstest.MapFS{}).ServeHTTP(w, httptest.NewRequest("GET", "/auth/login?"+url.Values{"return_to": {target}}.Encode(), nil))
	if w.Code != 302 || len(service.flows) != 1 {
		t.Fatal("flow not created")
	}
	for _, flow := range service.flows {
		if flow.ReturnTo != target || flow.Nonce == "" || flow.Verifier == "" {
			t.Fatal("flow lost return target or OIDC protection")
		}
	}
	for _, cookie := range w.Result().Cookies() {
		if cookie.Name == "ocms_state" && strings.Contains(cookie.Value, "assets") {
			t.Fatal("return target stored in cookie")
		}
	}
	w = httptest.NewRecorder()
	service.Handler(fstest.MapFS{}).ServeHTTP(w, httptest.NewRequest("GET", "/auth/login?return_to=https://example.com", nil))
	if w.Code != 400 || len(service.flows) != 1 {
		t.Fatal("invalid redirect created flow")
	}
}

func TestOIDCCallbackReturnsToOriginalRoute(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key}, nil)
	if err != nil {
		t.Fatal(err)
	}
	const issuer = "https://issuer.example"
	const clientID = "test-client"
	target := "/assets/id/view?from=favorites&page=2"
	claims, _ := json.Marshal(map[string]any{
		"iss": issuer, "sub": "subject", "aud": clientID,
		"exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(), "nonce": "test-nonce",
	})
	signed, err := signer.Sign(claims)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := signed.CompactSerialize()
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Error("invalid token request")
		}
		if r.Form.Get("code_verifier") != "test-verifier" || r.Form.Get("code") != "test-code" {
			t.Error("missing authorization code or PKCE verifier")
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"access_token": "test-access", "token_type": "Bearer", "id_token": raw})
	}))
	defer tokenServer.Close()
	catalog := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/principals" || r.Method != "POST" {
			t.Error("unexpected principal call")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"principal_id":"test-principal"}`))
	}))
	defer catalog.Close()
	t.Setenv("CATALOG_URL", catalog.URL)
	service := &Service{
		sessions: map[string]session{},
		flows:    map[string]flow{"test-state": {Nonce: "test-nonce", Verifier: "test-verifier", ReturnTo: target, Expiry: time.Now().Add(time.Minute)}},
		oauth:    oauth2.Config{ClientID: clientID, ClientSecret: "test-secret", Endpoint: oauth2.Endpoint{TokenURL: tokenServer.URL}},
		verifier: oidc.NewVerifier(issuer, &oidc.StaticKeySet{PublicKeys: []crypto.PublicKey{&key.PublicKey}}, &oidc.Config{ClientID: clientID}),
	}
	handler := service.Handler(fstest.MapFS{})
	request := func(state string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", "/auth/callback?code=test-code&state="+state, nil)
		r.AddCookie(&http.Cookie{Name: "ocms_state", Value: "test-state"})
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	if request("invalid-state").Code != 400 {
		t.Fatal("state mismatch accepted")
	}
	response := request("test-state")
	if response.Code != 303 || response.Header().Get("Location") != target || len(service.sessions) != 1 {
		t.Fatal("callback did not restore original route")
	}
	if request("test-state").Code != 400 {
		t.Fatal("callback replay accepted")
	}
}

func FuzzReturnTargetStaysLocal(f *testing.F) {
	for _, seed := range []string{"/", "/library?q=sample", "/assets/id/view?from=favorites", "//outside.example", "/%5coutside", "/assets/%00", "/tags?q=%E6%97%85%E8%A1%8C"} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, raw string) {
		target, ok := returnTarget(raw)
		if !ok {
			return
		}
		parsed, err := url.Parse(target)
		if err != nil || parsed.IsAbs() || parsed.Host != "" || !spaPath(parsed.Path) || !strings.HasPrefix(target, "/") || strings.HasPrefix(target, "//") {
			t.Fatal("accepted return target escaped application routes")
		}
		for _, c := range target {
			if c < 32 || c == 127 || c == '\\' {
				t.Fatal("accepted return target contained a control character")
			}
		}
		again, accepted := returnTarget(target)
		if !accepted || again != target {
			t.Fatal("return target is not stable under normalization")
		}
	})
}
