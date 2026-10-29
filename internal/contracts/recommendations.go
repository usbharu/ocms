package contracts

// RecommendationInput contains only metadata needed by the isolated engine.
type RecommendationInput struct {
	BlobIDs    []string `json:"blob_ids,omitempty"`
	SeriesKind string   `json:"series_kind,omitempty"`
	MemberIDs  []string `json:"member_ids,omitempty"`
	Version    int64    `json:"series_version,omitempty"`
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
