package bff

import (
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

func TestStaticCaching(t *testing.T) {
	s := &Service{}
	files := fstest.MapFS{
		"index.html":               {Data: []byte("<html>v1</html>")},
		"assets/index-Ab12_cd3.js": {Data: []byte("export default 1")},
		"assets/index.js":          {Data: []byte("unversioned")},
		"pdfjs/wasm/decoder.wasm":  {Data: []byte("decoder")},
	}
	handler := s.Handler(files)
	for _, tc := range []struct{ path, policy string }{
		{"/", "public, no-cache"},
		{"/library?q=sample&page=2", "public, no-cache"},
		{"/tags", "public, no-cache"},
		{"/characters", "public, no-cache"},
		{"/favorites", "public, no-cache"},
		{"/recommendations", "public, no-cache"},
		{"/assets/id", "public, no-cache"},
		{"/assets/id/view?from=favorites", "public, no-cache"},
		{"/assets/index-Ab12_cd3.js", "public, max-age=31536000, immutable"},
		{"/assets/index.js", "public, no-cache"},
		{"/pdfjs/wasm/decoder.wasm", "public, no-cache"},
	} {
		t.Run(tc.path, func(t *testing.T) {
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, httptest.NewRequest("GET", tc.path, nil))
			etag := w.Header().Get("ETag")
			if w.Code != 200 || w.Header().Get("Cache-Control") != tc.policy || etag == "" {
				t.Fatalf("unexpected static response: %d %v", w.Code, w.Header())
			}
			for _, method := range []string{"GET", "HEAD"} {
				r := httptest.NewRequest(method, tc.path, nil)
				r.Header.Set("If-None-Match", etag)
				w = httptest.NewRecorder()
				handler.ServeHTTP(w, r)
				if w.Code != 304 || w.Body.Len() != 0 || w.Header().Get("Cache-Control") != tc.policy {
					t.Fatalf("static revalidation failed: %d %v", w.Code, w.Header())
				}
			}
		})
	}
	for _, path := range []string{"/assets/missing-Ab12_cd3.js", "/auth/config", "/api/v1/me"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Header().Get("Cache-Control") != "private, no-store" {
			t.Fatalf("unexpected caching for %s: %v", path, w.Header())
		}
	}
	old := httptest.NewRecorder()
	handler.ServeHTTP(old, httptest.NewRequest("GET", "/", nil))
	files["index.html"] = &fstest.MapFile{Data: []byte("<html>v2</html>")}
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("If-None-Match", old.Header().Get("ETag"))
	w := httptest.NewRecorder()
	s.Handler(files).ServeHTTP(w, r)
	if w.Code != 200 || w.Body.String() != "<html>v2</html>" || w.Header().Get("ETag") == old.Header().Get("ETag") {
		t.Fatal("new build did not invalidate HTML")
	}
}

func TestUnknownSPARouteDoesNotReuseHTMLValidator(t *testing.T) {
	handler := (&Service{}).Handler(fstest.MapFS{
		"index.html": {Data: []byte("<html>application</html>")},
	})
	root := httptest.NewRecorder()
	handler.ServeHTTP(root, httptest.NewRequest("GET", "/", nil))
	for _, method := range []string{"GET", "HEAD"} {
		request := httptest.NewRequest(method, "/missing-page", nil)
		request.Header.Set("If-None-Match", root.Header().Get("ETag"))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != 404 || response.Header().Get("Cache-Control") != "private, no-store" || response.Header().Get("ETag") != "" {
			t.Fatalf("unknown page reused HTML cache: %d %v", response.Code, response.Header())
		}
		if method == "HEAD" && response.Body.Len() != 0 {
			t.Fatal("unknown page HEAD included a body")
		}
	}
}
