package media

import (
	"bufio"
	"context"
	"errors"
	"math/bits"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
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

func TestPDFBatchConcurrencyAndCancellation(t *testing.T) {
	started := make(chan int, 8)
	release := make(chan struct{})
	done := make(chan error, 1)
	var active, peak atomic.Int32
	go func() {
		done <- runPDFBatch(context.Background(), 8, 2, func(ctx context.Context, page int) error {
			n := active.Add(1)
			for old := peak.Load(); n > old && !peak.CompareAndSwap(old, n); old = peak.Load() {
			}
			started <- page
			select {
			case <-release:
			case <-ctx.Done():
			}
			active.Add(-1)
			return ctx.Err()
		})
	}()
	for i := 0; i < 2; i++ {
		select {
		case <-started:
		case <-time.After(5 * time.Second):
			t.Fatal("two pages did not start")
		}
	}
	if peak.Load() != 2 || active.Load() != 2 {
		t.Fatal("batch did not enforce the two-page limit")
	}
	close(release)
	if err := <-done; err != nil || peak.Load() != 2 {
		t.Fatalf("batch failed or exceeded concurrency: %v", err)
	}

	failure := errors.New("page failed")
	blocked := make(chan struct{})
	cancelled := make(chan struct{})
	err := runPDFBatch(context.Background(), 8, 2, func(ctx context.Context, page int) error {
		if page == 0 {
			<-blocked
			return failure
		}
		close(blocked)
		<-ctx.Done()
		close(cancelled)
		return ctx.Err()
	})
	if !errors.Is(err, failure) {
		t.Fatalf("lost page failure: %v", err)
	}
	select {
	case <-cancelled:
	default:
		t.Fatal("in-flight page was not cancelled")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := runPDFBatch(ctx, 3, 2, func(context.Context, int) error { t.Error("cancelled work started"); return nil }); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation not propagated: %v", err)
	}
}

func TestPDFBatchUsesConfiguredConcurrency(t *testing.T) {
	for _, limit := range []int{1, 3} {
		t.Run(strconv.Itoa(limit), func(t *testing.T) {
			started := make(chan struct{}, 6)
			release := make(chan struct{})
			done := make(chan error, 1)
			var active, peak atomic.Int32
			go func() {
				done <- runPDFBatch(context.Background(), 6, limit, func(ctx context.Context, _ int) error {
					n := active.Add(1)
					for old := peak.Load(); n > old && !peak.CompareAndSwap(old, n); old = peak.Load() {
					}
					started <- struct{}{}
					<-release
					active.Add(-1)
					return nil
				})
			}()
			for range limit {
				select {
				case <-started:
				case <-time.After(5 * time.Second):
					close(release)
					t.Fatal("configured number of pages did not start")
				}
			}
			close(release)
			if err := <-done; err != nil || peak.Load() != int32(limit) {
				t.Fatalf("expected peak %d, got %d: %v", limit, peak.Load(), err)
			}
		})
	}
}
