package media

import (
	"math"
	"ocms/internal/contracts"
	"strings"
	"testing"
)

func TestCheckpointIdentityAndValidation(t *testing.T) {
	identity := inferenceIdentity{Model: "test-model", Revision: "revision-1", DType: "float32"}
	input := map[string]any{"kind": "text", "text": "private-document-sentinel"}
	first, err := checkpointKey(identity, input)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(first, "private-document-sentinel") || len(first) != 64 {
		t.Fatal("input leaked in digest")
	}
	same, _ := checkpointKey(identity, map[string]any{"text": "private-document-sentinel", "kind": "text"})
	if first != same {
		t.Fatal("key depends on map order")
	}
	for _, changed := range []inferenceIdentity{{Model: "another", Revision: identity.Revision, DType: identity.DType}, {Model: identity.Model, Revision: "revision-2", DType: identity.DType}, {Model: identity.Model, Revision: identity.Revision, DType: "bfloat16"}} {
		key, _ := checkpointKey(changed, input)
		if key == first {
			t.Fatal("incompatible inference reused")
		}
	}
	value := contracts.Embedding{Model: identity.Model, Revision: identity.Revision, Vector: make([]float64, 768)}
	if !validCheckpoint(value, identity) {
		t.Fatal("valid checkpoint rejected")
	}
	value.Vector[0] = math.NaN()
	if validCheckpoint(value, identity) {
		t.Fatal("invalid vector accepted")
	}
	value.Vector = make([]float64, 767)
	if validCheckpoint(value, identity) {
		t.Fatal("invalid dimension accepted")
	}
	value.Vector = make([]float64, 768)
	value.Revision = "other"
	if validCheckpoint(value, identity) {
		t.Fatal("wrong revision accepted")
	}
}
