package search

import (
	"fmt"
	"testing"

	"ocms/internal/contracts"
)

func BenchmarkPersonalSamplingLarge(b *testing.B) {
	pool := make([]contracts.RecommendationScore, 1000)
	features := make(map[string][]string, 1000)
	for i := range pool {
		id := fmt.Sprint(i)
		pool[i] = contracts.RecommendationScore{ID: id, Score: 0.8}
		for j := 0; j < 80; j++ {
			features[id] = append(features[id], fmt.Sprintf("tag:%d", (i+j)%240))
		}
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		sampleRecommendations(pool, features, nil, func() float64 { return .5 })
	}
}
