package media

import (
	"math"
	"reflect"
	"testing"

	"ocms/internal/contracts"
)

func TestTagAggregation(t *testing.T) {
	scores := map[string]float64{"existing": .6}
	result := contracts.TagResult{Model: contracts.TagModel, Revision: contracts.TagRevision, Tags: []contracts.TagScore{{Name: "existing", Score: .9}, {Name: "new", Score: .8}}}
	if err := mergeTags(scores, result); err != nil {
		t.Fatal(err)
	}
	result.Tags = []contracts.TagScore{{Name: "existing", Score: .4}}
	if err := mergeTags(scores, result); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(sortedTags(scores), []string{"existing", "new"}) || scores["existing"] != .9 {
		t.Fatal("lost strongest page/frame score")
	}
	for _, score := range []float64{math.NaN(), math.Inf(1), -.1, 1.1, .34} {
		result.Tags = []contracts.TagScore{{Name: "invalid", Score: score}}
		if mergeTags(scores, result) == nil {
			t.Fatal("accepted invalid score")
		}
	}
	result.Model = "unexpected"
	if mergeTags(scores, result) == nil {
		t.Fatal("accepted unexpected model")
	}
}

func TestTagSampling(t *testing.T) {
	for _, duration := range []float64{.1, 5, 12, 60, 600} {
		times := tagFrameTimes(duration)
		if len(times) < 1 || len(times) > 12 || times[0] != 0 {
			t.Fatal("invalid sample count")
		}
		for _, second := range times {
			if second < 0 || second >= duration {
				t.Fatal("sample outside video")
			}
		}
		if duration >= 60 && times[len(times)-1] < duration*.9 {
			t.Fatal("missing end of video")
		}
	}
	for _, mime := range []string{"image/png", "video/mp4", "application/pdf"} {
		if !taggable(mime) {
			t.Fatal(mime)
		}
	}
	if taggable("audio/ogg") {
		t.Fatal("audio must not be tagged")
	}
}

func TestCharacterAggregationIsIndependent(t *testing.T) {
	scores := map[string]float64{}
	result := contracts.TagResult{Model: contracts.TagModel, Revision: contracts.TagRevision, Tags: []contracts.TagScore{{Name: "general", Score: .9}}, Characters: []contracts.TagScore{{Name: "character", Score: .85}}}
	if err := mergeCharacters(scores, result); err != nil {
		t.Fatal(err)
	}
	result.Characters[0].Score = .99
	if err := mergeCharacters(scores, result); err != nil {
		t.Fatal(err)
	}
	if len(scores) != 1 || scores["character"] != .99 {
		t.Fatal("character scores mixed or lost")
	}
	for _, score := range []float64{.849, math.NaN(), math.Inf(1), 1.1} {
		result.Characters[0].Score = score
		if mergeCharacters(scores, result) == nil {
			t.Fatal("invalid character confidence accepted")
		}
	}
}
