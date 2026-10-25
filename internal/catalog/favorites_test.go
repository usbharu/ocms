package catalog

import (
	"net/http/httptest"
	"testing"
)

func TestFavoriteFilter(t *testing.T) {
	for _, tc := range []struct {
		query         string
		want, invalid bool
	}{
		{"", false, false}, {"?favorites=true", true, false}, {"?favorites=false", false, false},
		{"?favorites=", false, true}, {"?favorites=yes", false, true}, {"?favorites=true&favorites=false", false, true},
	} {
		t.Run(tc.query, func(t *testing.T) {
			got, err := favoriteFilter(httptest.NewRequest("GET", "/api/v1/assets"+tc.query, nil))
			if (err != nil) != tc.invalid || got != tc.want {
				t.Fatalf("got %v, %v", got, err)
			}
		})
	}
}
