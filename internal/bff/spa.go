package bff

import (
	"io/fs"
	"net/http"
	"net/url"
	"path"
	"strings"
)

func spaPath(p string) bool {
	switch p {
	case "/", "/library", "/tags", "/characters", "/favorites", "/recommendations":
		return true
	}
	parts := strings.Split(strings.TrimPrefix(p, "/"), "/")
	return strings.HasPrefix(p, "/") && (len(parts) == 2 || len(parts) == 3 && parts[2] == "view") && parts[0] == "assets" && parts[1] != "" && parts[1] != "." && parts[1] != ".."
}

// Return targets are local application routes, never arbitrary redirect URLs.
func returnTarget(raw string) (string, bool) {
	if raw == "" {
		return "/", true
	}
	for _, c := range raw {
		if c < 32 || c == 127 || c == '\\' {
			return "", false
		}
	}
	decoded, decodeErr := url.PathUnescape(raw)
	if decodeErr != nil {
		return "", false
	}
	for _, c := range decoded {
		if c < 32 || c == 127 || c == '\\' {
			return "", false
		}
	}
	u, err := url.Parse(raw)
	if err != nil || u.IsAbs() || u.Host != "" || u.Opaque != "" || u.Fragment != "" || !strings.HasPrefix(raw, "/") || strings.HasPrefix(raw, "//") || strings.ContainsAny(u.Path, "\\\r\n\t") || !spaPath(u.Path) || path.Clean(u.Path) != u.Path {
		return "", false
	}
	return u.RequestURI(), true
}

func spaHandler(assets fs.FS) http.Handler {
	files := http.FileServer(http.FS(assets))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if p == "/api" || strings.HasPrefix(p, "/api/") || p == "/auth" || strings.HasPrefix(p, "/auth/") {
			http.NotFound(w, r)
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
			return
		}
		if info, err := fs.Stat(assets, strings.TrimPrefix(p, "/")); err == nil && !info.IsDir() {
			files.ServeHTTP(w, r)
			return
		}
		if p == "/pdfjs" || strings.HasPrefix(p, "/pdfjs/") || path.Ext(p) != "" {
			http.NotFound(w, r)
			return
		}
		data, err := fs.ReadFile(assets, "index.html")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if !spaPath(p) {
			w.WriteHeader(http.StatusNotFound)
		}
		if r.Method == "GET" {
			_, _ = w.Write(data)
		}
	})
}
