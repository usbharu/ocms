package bff

import (
	"crypto/sha256"
	"fmt"
	"io/fs"
	"net/http"
	"regexp"
	"strings"
)

// Vite's generated asset names contain an eight-character content hash.
var versionedAsset = regexp.MustCompile(`^assets/[^/]+-[A-Za-z0-9_-]{8}\.[^/]+$`)

func staticFiles(assets fs.FS) http.Handler {
	// The build directory stays fixed for the lifetime of the BFF. Compute
	// validators once, including for unversioned HTML and PDF.js resources.
	etags := map[string]string{}
	_ = fs.WalkDir(assets, ".", func(name string, entry fs.DirEntry, err error) error {
		if err == nil && !entry.IsDir() {
			if content, err := fs.ReadFile(assets, name); err == nil {
				etags[name] = fmt.Sprintf(`"%x"`, sha256.Sum256(content))
			}
		}
		return nil
	})
	files := http.FileServer(http.FS(assets))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/")
		if name == "" {
			name = "index.html"
		}
		if etag, ok := etags[name]; ok && (r.Method == "GET" || r.Method == "HEAD") && !strings.HasSuffix(r.URL.Path, "/index.html") {
			policy := "public, no-cache"
			if versionedAsset.MatchString(name) {
				policy = "public, max-age=31536000, immutable"
			}
			w.Header().Set("Cache-Control", policy)
			w.Header().Set("ETag", etag)
		}
		files.ServeHTTP(staticResponse{w}, r)
	})
}

type staticResponse struct{ http.ResponseWriter }

func (w staticResponse) WriteHeader(status int) {
	// ServeContent clears cache headers on errors; keep errors non-cacheable.
	if status >= 400 {
		w.Header().Set("Cache-Control", "private, no-store")
		w.Header().Del("ETag")
	}
	w.ResponseWriter.WriteHeader(status)
}
