package contracts

import (
	"net/url"
	"reflect"
	"testing"
)

func TestRatingFilters(t *testing.T) {
	for _, tc := range []struct {
		query   string
		want    []string
		invalid bool
	}{
		{"", nil, false}, {"ratings=", []string{}, false},
		{"ratings=general,explicit,unrated", []string{"general", "explicit", "unrated"}, false},
		{"ratings=unknown", nil, true}, {"ratings=general&ratings=explicit", nil, true},
		{"ratings=general,", nil, true},
	} {
		q, _ := url.ParseQuery(tc.query)
		got, err := ParseRatings(q)
		if (err != nil) != tc.invalid || (err == nil && !reflect.DeepEqual(got, tc.want)) {
			t.Fatalf("%s: %v %v", tc.query, got, err)
		}
	}
	if !MatchesRating("general", nil) || MatchesRating("general", []string{}) || MatchesRating("explicit", []string{"general"}) || !MatchesRating("unrated", []string{"unrated"}) {
		t.Fatal("filter semantics changed")
	}
	if RatingLevel("unrated") != -1 || ValidRating("") || ValidRating("r18") {
		t.Fatal("invalid rating accepted")
	}
}
