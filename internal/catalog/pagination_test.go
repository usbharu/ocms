package catalog

import (
	"net/http/httptest"
	"reflect"
	"testing"
)

func TestListOptions(t *testing.T) {
	for _, tc := range []struct {
		query   string
		want    listOptions
		invalid bool
	}{
		{"", listOptions{limit: 200}, false},
		{"?limit=24&offset=216&kind=image", listOptions{limit: 24, offset: 216, kind: "image"}, false},
		{"?kind=document", listOptions{limit: 200, kind: "document"}, false},
		{query: "?limit=0", invalid: true},
		{query: "?limit=201", invalid: true},
		{query: "?offset=-1", invalid: true},
		{query: "?offset=999999999999999999999999", invalid: true},
		{query: "?limit=abc", invalid: true},
		{query: "?offset=", invalid: true},
		{query: "?limit=24&limit=48", invalid: true},
		{query: "?kind=unknown", invalid: true},
	} {
		t.Run(tc.query, func(t *testing.T) {
			got, err := parseListOptions(httptest.NewRequest("GET", "/api/v1/assets"+tc.query, nil))
			if (err != nil) != tc.invalid {
				t.Fatalf("invalid = %v, want %v", err != nil, tc.invalid)
			}
			if err == nil && !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %+v, want %+v", got, tc.want)
			}
		})
	}
}
