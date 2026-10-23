package contracts

const TagModel = "SmilingWolf/wd-v1-4-convnext-tagger-v2"
const TagRevision = "4b34d1b07bdd8e95494072648960b8a6adcbc0ff"

// TagResult contains only general labels; ratings and characters are excluded by Runtime.
type TagResult struct {
	Tags     []TagScore `json:"tags"`
	Model    string     `json:"model_id"`
	Revision string     `json:"model_revision"`
}

type TagScore struct {
	Name  string  `json:"name"`
	Score float64 `json:"score"`
}
