package search

import (
	"math"
	"testing"
)

func TestAudioAlignmentAndSignedFingerprint(t *testing.T) {
	a := []int32{-12345678, 4211398, -98322114, 191991, 2928292, -191922, 3848176, 196388, 492228, 1923992}
	b := append([]int32{12, 34}, a...)
	if d := audioDistance(a, b); d != 0 {
		t.Fatalf("aligned fingerprint distance=%f", d)
	}
	opposite := make([]int32, len(a))
	for i, v := range a {
		opposite[i] = ^v
	}
	if d := audioDistance(a, opposite); d <= 0.25 {
		t.Fatalf("unrelated fingerprint accepted: %f", d)
	}
	if d := audioDistance(nil, a); d != 1 {
		t.Fatal("empty fingerprint matched")
	}
}
func TestRejectMalformedInferenceVector(t *testing.T) {
	if _, err := vectorString([]float64{1}); err == nil {
		t.Fatal("wrong dimension accepted")
	}
	v := make([]float64, 768)
	v[5] = math.NaN()
	if _, err := vectorString(v); err == nil {
		t.Fatal("NaN accepted")
	}
	v[5] = math.Inf(1)
	if _, err := vectorString(v); err == nil {
		t.Fatal("infinite component accepted")
	}
}
