package contracts

import "strings"

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

// NormalizeTag stores labels in the Danbooru-style underscore form used by WD14.
// CL Tagger v2 returns names with spaces, so both automatic and manual labels
// pass through this form before they are compared or saved.
func NormalizeTag(name string) string {
	return strings.ReplaceAll(strings.TrimSpace(name), " ", "_")
}

// NormalizeTags removes empty and duplicate labels after normalization while
// preserving the first occurrence order. A nil input stays nil so callers can
// distinguish an omitted list from an explicitly empty one.
func NormalizeTags(names []string) []string {
	if names == nil {
		return nil
	}
	normalized := make([]string, 0, len(names))
	seen := make(map[string]struct{}, len(names))
	for _, name := range names {
		name = NormalizeTag(name)
		if name == "" {
			continue
		}
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		normalized = append(normalized, name)
	}
	return normalized
}
