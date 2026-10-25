package search

import (
	"fmt"
	"math/rand/v2"
	"ocms/internal/contracts"
	"reflect"
	"testing"
)

func TestPersonalSampling(t *testing.T) {
	pool := []contracts.RecommendationScore{}
	features := map[string][]string{}
	for i := 0; i < 250; i++ {
		id := fmt.Sprintf("%03d", i)
		pool = append(pool, contracts.RecommendationScore{ID: id, Score: 0.5})
		features[id] = []string{fmt.Sprint(i % 5)}
	}
	draw := func(seed uint64) []contracts.RecommendationScore {
		return sampleRecommendations(pool, features, nil, rand.New(rand.NewPCG(seed, 2)).Float64)
	}
	first := draw(1)
	if len(first) != 200 || !reflect.DeepEqual(first, draw(1)) || reflect.DeepEqual(first, draw(3)) {
		t.Fatal("sampling must be reproducible, varied and bounded")
	}
	seen := map[string]bool{}
	for _, c := range first {
		if seen[c.ID] {
			t.Fatal("duplicate across pages")
		}
		seen[c.ID] = true
	}
	if len(sampleRecommendations(nil, nil, nil, func() float64 { return 0 })) != 0 {
		t.Fatal("empty pool")
	}
}

func TestPersonalSamplingWeights(t *testing.T) {
	pool := []contracts.RecommendationScore{{ID: "a", Score: 1}, {ID: "b", Score: 0.5}, {ID: "c", Score: 0.5}}
	next := func() float64 { return 0.6 }
	if sampleRecommendations(pool, nil, nil, next)[0].ID != "a" {
		t.Fatal("score must be squared")
	}
	if sampleRecommendations(pool, nil, map[string]bool{"a": true}, next)[0].ID != "b" {
		t.Fatal("history must reduce weight")
	}
	pool = []contracts.RecommendationScore{{ID: "a", Score: 1}, {ID: "b", Score: 1}, {ID: "c", Score: 1}}
	calls := 0
	next = func() float64 {
		calls++
		if calls == 1 {
			return 0
		}
		return 0.2
	}
	out := sampleRecommendations(pool, map[string][]string{"a": {"x"}, "b": {"x"}, "c": {"y"}}, nil, next)
	if out[1].ID != "c" {
		t.Fatal("diversity must reduce redundant features")
	}
}

func TestPersonalCandidateFilters(t *testing.T) {
	blob := "favorite"
	cache := personalCache{RecommendationPool: contracts.RecommendationPool{Candidates: []contracts.RecommendationScore{{ID: "f", Score: 1}, {ID: "same", Score: 1}, {ID: "good", Score: 0.5}, {ID: "good", Score: 0.5}, {ID: "hidden", Score: 1}}}, Assets: []contracts.RecommendationInput{
		{ID: "f", Favorite: true, BlobID: &blob}, {ID: "same", BlobID: &blob}, {ID: "good", MIME: "image/png", Rating: "general", Tags: []string{"x"}},
	}}
	pool, _ := personalCandidates(cache, personalConditions{Kind: "image", Ratings: []string{"general"}})
	if len(pool) != 1 || pool[0].ID != "good" {
		t.Fatal("favorite, blob duplicate, unauthorized, or duplicate candidate escaped")
	}
	pool, _ = personalCandidates(cache, personalConditions{Kind: "all", Ratings: []string{}})
	if len(pool) != 0 {
		t.Fatal("empty ratings must match nothing")
	}
}
