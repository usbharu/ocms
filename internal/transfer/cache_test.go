package transfer

import (
	"net/http/httptest"
	"testing"
)

func TestMediaValidators(t *testing.T) {
	for _, tc := range []struct {
		method string
		values []string
		match  bool
	}{
		{"GET", nil, false},
		{"GET", []string{`"old"`}, false},
		{"GET", []string{`"current"`}, true},
		{"HEAD", []string{`W/"current"`}, true},
		{"GET", []string{`"old", W/"current"`}, true},
		{"GET", []string{`"old"`, `"current"`}, true},
		{"GET", []string{"*"}, true},
		{"GET", []string{"current"}, false},
		{"POST", []string{`"current"`}, false},
	} {
		r := httptest.NewRequest(tc.method, "/api/v1/assets/test/content", nil)
		r.Header["If-None-Match"] = tc.values
		// Matching validators take precedence even over an unsatisfiable Range.
		r.Header.Set("Range", "bytes=99999999-")
		if got := notModified(r, `"current"`); got != tc.match {
			t.Errorf("%s %v: match=%v, want %v", tc.method, tc.values, got, tc.match)
		}
	}
}
