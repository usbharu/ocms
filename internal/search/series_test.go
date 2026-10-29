package search

import (
	"ocms/internal/catalog"
	"ocms/internal/contracts"
	"testing"
)

func TestSeriesTitleAndBlobIdentity(t *testing.T) {
	for _, v := range []string{"comic_001.png", "Comic page002.jpg", "comic (003).webp"} {
		if seriesTitle(v) != "comic" {
			t.Fatalf("failed page normalization: %q", v)
		}
	}
	if titleSimilarity("漫画 01.png", "漫画 02.jpg") != 1 || titleSimilarity("001.png", "002.png") != 0 {
		t.Fatal("invalid title similarity")
	}
	a := catalog.Asset{BlobIDs: []string{"one", "two"}}
	blob := "two"
	if !sharedBlob(a, catalog.Asset{BlobID: &blob}) {
		t.Fatal("must compare every constituent blob")
	}
	cache := personalCache{Assets: []contracts.RecommendationInput{
		{ID: "favorite", Favorite: true, BlobIDs: []string{"one", "two"}},
		{ID: "duplicate", BlobID: &blob, Tags: []string{"tag"}, MIME: "image/png", Rating: "general"},
		{ID: "series", BlobIDs: []string{"three"}, Tags: []string{"tag"}, MIME: catalog.SeriesMIME, SeriesKind: "composite", Rating: "general"},
	}, RecommendationPool: contracts.RecommendationPool{Candidates: []contracts.RecommendationScore{{ID: "duplicate", Score: 1}, {ID: "series", Score: 1}}}}
	pool, _ := personalCandidates(cache, personalConditions{Kind: "series"})
	if len(pool) != 1 || pool[0].ID != "series" {
		t.Fatal("series filtering or constituent deduplication failed")
	}
}
