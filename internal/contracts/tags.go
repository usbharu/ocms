package contracts

const TagModel = "cella110n/cl_tagger_v2"
const TagRevision = "b57909b8e9c63f71e208a26473e7aabdf45ed6b6"
const TagThreshold = 0.55
const CharacterThreshold = 0.55

// TagResult separates general labels, characters and content rating.
type TagResult struct {
	Rating     string     `json:"rating"`
	Tags       []TagScore `json:"tags"`
	Characters []TagScore `json:"characters"`
	Model      string     `json:"model_id"`
	Revision   string     `json:"model_revision"`
}

type TagScore struct {
	Name  string  `json:"name"`
	Score float64 `json:"score"`
}
