package transfer

import "testing"

func TestPartBoundaries(t *testing.T) {
	for _, tc := range []struct {
		size   int64
		number int
		want   int64
	}{
		{0, 0, 0}, {1, -1, 0}, {1, 0, 1}, {1, 1, 0},
		{uploadPartSize, 0, uploadPartSize}, {uploadPartSize, 1, 0},
		{uploadPartSize + 1, 0, uploadPartSize}, {uploadPartSize + 1, 1, 1},
		{uploadPartSize + 1, 2, 0}, {1 << 30, 127, uploadPartSize}, {1 << 30, 128, 0},
	} {
		got, err := partLength(tc.size, tc.number)
		if tc.want == 0 {
			if err == nil {
				t.Fatalf("accepted size %d part %d", tc.size, tc.number)
			}
			continue
		}
		if err != nil || got != tc.want {
			t.Fatalf("size %d part %d: %d %v", tc.size, tc.number, got, err)
		}
	}
}

func TestPartsMustBeCompleteAndReady(t *testing.T) {
	complete := []uploadPart{{Number: 0, Size: uploadPartSize, Ready: true}, {Number: 1, Size: 17, Ready: true}}
	if !validParts(complete, uploadPartSize+17) || !validParts(nil, 0) {
		t.Fatal("complete upload rejected")
	}
	if validParts(complete[:1], uploadPartSize+17) {
		t.Fatal("missing part accepted")
	}
	for _, parts := range [][]uploadPart{
		{{Number: 0, Size: uploadPartSize, Ready: true}, {Number: 2, Size: 17, Ready: true}},
		{{Number: 0, Size: uploadPartSize, Ready: true}, {Number: 1, Size: 16, Ready: true}},
		{{Number: 0, Size: uploadPartSize, Ready: true}, {Number: 1, Size: 17, Ready: false}},
	} {
		if validParts(parts, uploadPartSize+17) {
			t.Fatal("invalid upload accepted")
		}
	}
}
