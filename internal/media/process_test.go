package media

import (
	"math/bits"
	"strconv"
	"testing"
)

func TestPHashBrightnessInvariance(t *testing.T) {
	first, brighter := make([]byte, 1024), make([]byte, 1024)
	for x := 0; x < 32; x++ {
		for y := 0; y < 32; y++ {
			v := byte((x*x + y*3) % 160)
			first[x*32+y] = v
			brighter[x*32+y] = v + 40
		}
	}
	a, err := strconv.ParseUint(phash(first), 2, 64)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := strconv.ParseUint(phash(brighter), 2, 64)
	if distance := bits.OnesCount64(a ^ b); distance > 2 {
		t.Fatalf("brightness shift changed %d bits", distance)
	}
}
