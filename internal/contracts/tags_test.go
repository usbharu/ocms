package contracts

import (
	"reflect"
	"testing"
)

func TestNormalizeTags(t *testing.T) {
	got := NormalizeTags([]string{" long hair ", "long_hair", "solo", "", "   ", "blue eyes", "solo"})
	want := []string{"long_hair", "solo", "blue_eyes"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if NormalizeTags(nil) != nil || NormalizeTags([]string{}) == nil {
		t.Fatal("nil and empty inputs must stay distinguishable")
	}
	if NormalizeTag(" character name ") != "character_name" {
		t.Fatal("unexpected tag normalization")
	}
}
