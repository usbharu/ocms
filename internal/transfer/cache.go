package transfer

import (
	"net/http"
	"strings"
)

// If-None-Match uses weak comparison for GET/HEAD, before evaluating Range.
// Current ETags are quoted SHA-256 hex, so they cannot contain commas.
func notModified(r *http.Request, etag string) bool {
	if r.Method != "GET" && r.Method != "HEAD" {
		return false
	}
	for _, line := range r.Header.Values("If-None-Match") {
		for _, candidate := range strings.Split(line, ",") {
			candidate = strings.TrimSpace(candidate)
			if candidate == "*" || strings.TrimPrefix(candidate, "W/") == etag {
				return true
			}
		}
	}
	return false
}
