package transfer

import "testing"

func TestRangeContract(t *testing.T) {
	for _, tc := range []struct {
		value            string
		size, start, end int64
		partial, bad     bool
	}{
		{"", 100, 0, 99, false, false}, {"bytes=17-31", 100, 17, 31, true, false}, {"bytes=99-", 100, 99, 99, true, false},
		{"bytes=-7", 100, 93, 99, true, false}, {"bytes=-999", 100, 0, 99, true, false}, {"bytes=3-999", 100, 3, 99, true, false},
		{"bytes=100-", 100, 0, 0, false, true}, {"bytes=7-2", 100, 0, 0, false, true}, {"bytes=-0", 100, 0, 0, false, true},
		{"bytes=0-0", 0, 0, 0, false, true}, {"bytes=0-1,5-9", 100, 0, 99, false, false}, {"", 0, 0, -1, false, false},
		{"bytes=+1-3", 100, 0, 0, false, true}, {"bytes=0-9223372036854775808", 100, 0, 0, false, true},
	} {
		t.Run(tc.value, func(t *testing.T) {
			a, b, p, e := ParseRange(tc.value, tc.size)
			if (e != nil) != tc.bad || (!tc.bad && (a != tc.start || b != tc.end || p != tc.partial)) {
				t.Fatalf("got %d %d %t %v", a, b, p, e)
			}
		})
	}
}
