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
	case "/groups", "/", "/library", "/tags", "/characters", "/favorites", "/recommendations", "/series", "/series/new":
		return true
	}
	parts := strings.Split(strings.TrimPrefix(p, "/"), "/")
	return strings.HasPrefix(p, "/") && (len(parts) == 2 || len(parts) == 3 && (parts[2] == "view" || parts[0] == "series" && parts[2] == "edit")) && (parts[0] == "assets" || parts[0] == "series" || parts[0] == "groups" && len(parts) == 2) && parts[1] != "" && parts[1] != "." && parts[1] != ".."
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
	files := staticFiles(assets)
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
		if spaPath(p) {
			// Serve the app shell with the same validators as the root HTML.
			request := r.Clone(r.Context())
			request.URL.Path = "/"
			request.URL.RawPath = ""
			files.ServeHTTP(w, request)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		if r.Method == "GET" {
			_, _ = w.Write(data)
		}
	})
}
