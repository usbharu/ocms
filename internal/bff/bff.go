package bff

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io/fs"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
	"ocms/internal/cryptostore"
	"ocms/internal/platform"
)

type session struct {
	Principal, CSRF string
	Expiry          time.Time
}
type flow struct {
	Nonce, Verifier string
	Expiry          time.Time
}
type Service struct {
	mu          sync.Mutex
	sessions    map[string]session
	flows       map[string]flow
	oauth       oauth2.Config
	verifier    *oidc.IDTokenVerifier
	origin      string
	secure, dev bool
}

func token() string { return base64.RawURLEncoding.EncodeToString(cryptostore.Random(32)) }
func New(ctx context.Context) (*Service, error) {
	origin := platform.Env("PUBLIC_URL", "http://localhost:8080")
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" || u.Path != "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, errors.New("invalid public URL")
	}
	s := &Service{sessions: map[string]session{}, flows: map[string]flow{}, origin: origin, secure: u.Scheme == "https", dev: platform.Env("AUTH_MODE", "oidc") == "development"}
	if s.dev {
		if u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1" {
			return nil, errors.New("development auth requires localhost public URL")
		}
		return s, nil
	}
	if os.Getenv("AUTH_MODE") != "" && os.Getenv("AUTH_MODE") != "oidc" {
		return nil, errors.New("invalid authentication mode")
	}
	ctx = oidc.ClientContext(ctx, platform.Client)
	provider, err := oidc.NewProvider(ctx, os.Getenv("OIDC_ISSUER"))
	if err != nil {
		return nil, errors.New("OIDC discovery failed")
	}
	s.oauth = oauth2.Config{ClientID: os.Getenv("OIDC_CLIENT_ID"), ClientSecret: os.Getenv("OIDC_CLIENT_SECRET"), RedirectURL: origin + "/auth/callback", Endpoint: provider.Endpoint(), Scopes: []string{oidc.ScopeOpenID}}
	if s.oauth.ClientID == "" || s.oauth.ClientSecret == "" {
		return nil, errors.New("OIDC client configuration missing")
	}
	s.verifier = provider.Verifier(&oidc.Config{ClientID: s.oauth.ClientID})
	return s, nil
}
func (s *Service) cookie(w http.ResponseWriter, name, value string, max int) {
	http.SetCookie(w, &http.Cookie{Name: name, Value: value, Path: "/", HttpOnly: true, Secure: s.secure, SameSite: http.SameSiteLaxMode, MaxAge: max})
}
func (s *Service) cleanup() {
	now := time.Now()
	for k, v := range s.sessions {
		if now.After(v.Expiry) {
			delete(s.sessions, k)
		}
	}
	for k, v := range s.flows {
		if now.After(v.Expiry) {
			delete(s.flows, k)
		}
	}
}
func (s *Service) loginSession(w http.ResponseWriter, r *http.Request, issuer, sub string) {
	var out struct {
		ID string `json:"principal_id"`
	}
	if err := platform.Call(r.Context(), "POST", os.Getenv("CATALOG_URL")+"/internal/principals", "", map[string]string{"issuer": issuer, "subject": sub}, &out); err != nil {
		platform.RespondError(w, err)
		return
	}
	value := token()
	s.mu.Lock()
	s.cleanup()
	s.sessions[value] = session{Principal: out.ID, CSRF: token(), Expiry: time.Now().Add(12 * time.Hour)}
	s.mu.Unlock()
	s.cookie(w, "ocms_session", value, 43200)
	platform.Audit(r.Context(), "auth.login", out.ID, "")
	http.Redirect(w, r, "/", http.StatusSeeOther)
}
func (s *Service) Handler(assets fs.FS) http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("GET /auth/config", func(w http.ResponseWriter, r *http.Request) {
		platform.JSON(w, 200, map[string]bool{"development": s.dev})
	})
	m.HandleFunc("POST /auth/dev-login", func(w http.ResponseWriter, r *http.Request) {
		if !s.dev {
			platform.Error(w, 404, "NOT_FOUND")
			return
		}
		if r.Header.Get("Origin") != s.origin {
			platform.Error(w, 403, "FORBIDDEN")
			return
		}
		var in struct {
			User string `json:"user"`
		}
		if !platform.Decode(w, r, &in) {
			return
		}
		if in.User != "alice" && in.User != "bob" {
			platform.Error(w, 400, "INVALID_REQUEST")
			return
		}
		s.loginSession(w, r, "urn:ocms:development", in.User)
	})
	m.HandleFunc("GET /auth/login", func(w http.ResponseWriter, r *http.Request) {
		if s.dev {
			http.Redirect(w, r, "/", 303)
			return
		}
		state, nonce, verifier := token(), token(), oauth2.GenerateVerifier()
		s.mu.Lock()
		s.cleanup()
		s.flows[state] = flow{Nonce: nonce, Verifier: verifier, Expiry: time.Now().Add(5 * time.Minute)}
		s.mu.Unlock()
		s.cookie(w, "ocms_state", state, 300)
		http.Redirect(w, r, s.oauth.AuthCodeURL(state, oidc.Nonce(nonce), oauth2.S256ChallengeOption(verifier)), 302)
	})
	m.HandleFunc("GET /auth/callback", func(w http.ResponseWriter, r *http.Request) {
		if s.dev {
			platform.Error(w, 404, "NOT_FOUND")
			return
		}
		state := r.URL.Query().Get("state")
		c, err := r.Cookie("ocms_state")
		if err != nil || state == "" || subtle.ConstantTimeCompare([]byte(state), []byte(c.Value)) != 1 {
			platform.Error(w, 400, "OIDC_STATE_INVALID")
			return
		}
		s.mu.Lock()
		f, ok := s.flows[state]
		delete(s.flows, state)
		s.mu.Unlock()
		s.cookie(w, "ocms_state", "", -1)
		if !ok || time.Now().After(f.Expiry) {
			platform.Error(w, 400, "OIDC_STATE_INVALID")
			return
		}
		tok, err := s.oauth.Exchange(oidc.ClientContext(r.Context(), platform.Client), r.URL.Query().Get("code"), oauth2.VerifierOption(f.Verifier))
		if err != nil {
			platform.Error(w, 401, "OIDC_EXCHANGE_FAILED")
			return
		}
		raw, ok := tok.Extra("id_token").(string)
		if !ok {
			platform.Error(w, 401, "OIDC_TOKEN_INVALID")
			return
		}
		identity, err := s.verifier.Verify(r.Context(), raw)
		if err != nil || identity.Nonce != f.Nonce {
			platform.Error(w, 401, "OIDC_TOKEN_INVALID")
			return
		}
		s.loginSession(w, r, identity.Issuer, identity.Subject)
	})
	m.Handle("/api/", s.auth(http.HandlerFunc(s.proxy)))
	m.Handle("POST /auth/logout", s.auth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, _ := r.Cookie("ocms_session")
		s.mu.Lock()
		delete(s.sessions, c.Value)
		s.mu.Unlock()
		s.cookie(w, "ocms_session", "", -1)
		w.WriteHeader(204)
	})))
	fileServer := http.FileServer(http.FS(assets))
	m.Handle("/", fileServer)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "private, no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; font-src 'self' blob:; img-src 'self' blob:; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'")
		m.ServeHTTP(w, r)
	})
}
func (s *Service) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie("ocms_session")
		if err != nil {
			platform.Error(w, 401, "AUTH_REQUIRED")
			return
		}
		s.mu.Lock()
		sess, ok := s.sessions[c.Value]
		s.mu.Unlock()
		if !ok || time.Now().After(sess.Expiry) {
			platform.Error(w, 401, "AUTH_REQUIRED")
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" {
			if r.Header.Get("Origin") != s.origin || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-CSRF-Token")), []byte(sess.CSRF)) != 1 {
				platform.Error(w, 403, "CSRF_INVALID")
				return
			}
		}
		// Never forward client-supplied identity, credentials or trace baggage to services.
		r.Header.Del("X-Principal")
		r.Header.Del("X-Service-Token")
		r.Header.Del("Authorization")
		r.Header.Del("Cookie")
		r.Header.Del("Baggage")
		r.Header.Del("X-Job-ID")
		r.Header.Del("X-Job-Lease")
		r.Header.Set("X-Principal", sess.Principal)
		if r.URL.Path == "/api/v1/me" {
			if r.Method != "GET" {
				platform.Error(w, 405, "METHOD_NOT_ALLOWED")
				return
			}
			platform.JSON(w, 200, map[string]string{"principal_id": sess.Principal, "csrf_token": sess.CSRF})
			return
		}
		// Logout needs its session cookie locally, but it is never forwarded to a service.
		if r.URL.Path == "/auth/logout" {
			r.AddCookie(c)
		}
		next.ServeHTTP(w, r)
	})
}
func (s *Service) proxy(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	upstream := os.Getenv("CATALOG_URL")
	switch {
	case path == "/api/v1/search" || strings.HasSuffix(path, "/similar"):
		upstream = os.Getenv("SEARCH_URL")
	case strings.HasSuffix(path, "/content") || strings.HasSuffix(path, "/preview"):
		upstream = os.Getenv("TRANSFER_URL")
	case strings.HasPrefix(path, "/api/v1/jobs/") || strings.HasSuffix(path, "/renditions") || strings.HasSuffix(path, "/jobs"):
		upstream = os.Getenv("MEDIA_URL")
	case path == "/api/v1/tags" || strings.HasPrefix(path, "/api/v1/assets") || strings.HasPrefix(path, "/api/v1/uploads"):
	default:
		platform.Error(w, 404, "NOT_FOUND")
		return
	}
	target, err := url.Parse(upstream)
	if err != nil {
		platform.Error(w, 503, "SERVICE_UNAVAILABLE")
		return
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.Transport = platform.Client.Transport
	original := proxy.Director
	proxy.Director = func(req *http.Request) {
		original(req)
		req.Header.Set("X-Service-Token", os.Getenv("INTERNAL_TOKEN"))
		req.Header.Del("X-CSRF-Token")
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) { platform.Error(w, 503, "SERVICE_UNAVAILABLE") }
	proxy.ServeHTTP(w, r)
}

// SessionDigest is suitable for future shared session storage without persisting cookies.
func SessionDigest(v string) string { h := sha256.Sum256([]byte(v)); return hex.EncodeToString(h[:]) }
