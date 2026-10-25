package contracts

// RecommendationInput contains only metadata needed by the isolated engine.
type RecommendationInput struct {
	ID         string   `json:"asset_id"`
	BlobID     *string  `json:"blob_id"`
	Tags       []string `json:"tags"`
	Characters []string `json:"characters"`
	Favorite   bool     `json:"is_favorite"`
	MIME       string   `json:"mime_type"`
	Rating     string   `json:"rating"`
}

type RecommendationDataset struct {
	Fingerprint string                `json:"fingerprint"`
	Unchanged   bool                  `json:"unchanged"`
	Assets      []RecommendationInput `json:"assets"`
}

type RecommendationScore struct {
	ID    string  `json:"asset_id"`
	Score float64 `json:"score"`
}

type RecommendationPool struct {
	Status     string                `json:"status"`
	Candidates []RecommendationScore `json:"candidates"`
}
