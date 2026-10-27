package media

import (
	"bufio"
	"context"
	"math/bits"
	"os"
	"path/filepath"
	"strconv"
	"strings"
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

func TestPHashCompatibility(t *testing.T) {
	for seed, want := range map[int]string{
		1:  "0010101011010101000011101010110000011111100000110011000011011011",
		7:  "0110110001001101010110000011000010001001011111110110110100110010",
		19: "0101100000011001111100001000010111111100000000101011100110011111",
	} {
		samples := make([]byte, 1024)
		for i := range samples {
			samples[i] = byte((i*i + seed*i + seed*17) % 251)
		}
		if phash(samples) != want {
			t.Fatalf("pHash changed for seed %d", seed)
		}
	}
}

func TestPDFTextPages(t *testing.T) {
	long := strings.Repeat("text ", 20000)
	reader := bufio.NewReader(strings.NewReader(long + "\f\fthird\f"))
	for _, want := range []string{strings.TrimSpace(long), "", "third", ""} {
		got, err := readPDFTextPage(reader)
		if err != nil || got != want {
			t.Fatal("PDF page text lost or attributed to the wrong page")
		}
	}
	if _, err := readPDFTextPage(bufio.NewReader(strings.NewReader(strings.Repeat("x", (2<<20)+1)))); errorCode(err) != "OUTPUT_TOO_LARGE" {
		t.Fatal("oversized page text accepted")
	}
}

func TestFFmpegSeekBeforeInput(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "args")
	tool := filepath.Join(dir, "ffmpeg")
	if err := os.WriteFile(tool, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$FFMPEG_TEST_ARGS\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	t.Setenv("FFMPEG_TEST_ARGS", logPath)
	if err := ffmpegAt(context.Background(), "source", "frame.png", "7.500", "-frames:v", "1"); err != nil {
		t.Fatal(err)
	}
	args, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(args), "-ss\n7.500\n-i\nsource\n") {
		t.Fatalf("seek must precede the input: %s", args)
	}
}
