package media

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func TestProcessingLimits(t *testing.T) {
	t.Setenv("MEDIA_MAX_PDF_PAGES", "")
	t.Setenv("MEDIA_JOB_TIMEOUT_SECONDS", "")
	if pdfPageLimit() != 500 || jobTimeout() != 2*time.Hour {
		t.Fatal("document defaults incorrect")
	}
	t.Setenv("MEDIA_MAX_PDF_PAGES", "70")
	t.Setenv("MEDIA_JOB_TIMEOUT_SECONDS", "3600")
	if pdfPageLimit() != 70 || jobTimeout() != time.Hour {
		t.Fatal("configured limits ignored")
	}
	for _, bad := range []string{"0", "-1", "abc", "99999999"} {
		t.Setenv("MEDIA_MAX_PDF_PAGES", bad)
		t.Setenv("MEDIA_JOB_TIMEOUT_SECONDS", bad)
		if pdfPageLimit() != 500 || jobTimeout() != 2*time.Hour {
			t.Fatal("invalid configuration accepted")
		}
	}
}
func TestToolFailuresPreserveCauseWithoutContent(t *testing.T) {
	for _, tc := range []struct{ diagnostic, code string }{
		{"No space left on device", "WORKSPACE_EXHAUSTED"},
		{"Cannot allocate memory", "MEDIA_MEMORY_EXCEEDED"},
		{"Invalid data found when processing input", "MEDIA_INVALID_DATA"},
	} {
		if errorCode(toolFailure(context.Background(), tc.diagnostic)) != tc.code {
			t.Fatal(tc.code)
		}
	}
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	if errorCode(toolFailure(ctx, "")) != "JOB_DEADLINE_EXCEEDED" {
		t.Fatal("deadline cause lost")
	}
	var output bytes.Buffer
	previous := slog.Default()
	defer slog.SetDefault(previous)
	slog.SetDefault(slog.New(slog.NewJSONHandler(&output, nil)))
	_, err := command(context.Background(), "sh", "-c", "echo private-document-sentinel >&2; exit 7")
	if err == nil || strings.Contains(output.String(), "private-document-sentinel") || !strings.Contains(output.String(), `"exit_code":7`) {
		t.Fatal("unsafe or incomplete diagnostic")
	}
	if retryable(processingError("MIME_MISMATCH")) || !retryable(context.DeadlineExceeded) {
		t.Fatal("retry policy incorrect")
	}
}

func TestConcurrencySettings(t *testing.T) {
	for _, setting := range []struct {
		name string
		read func() (int, error)
	}{
		{"MEDIA_WORKER_CONCURRENCY", WorkerConcurrency},
		{"MEDIA_PDF_PAGE_CONCURRENCY", PDFPageConcurrency},
	} {
		t.Setenv(setting.name, "")
		if n, err := setting.read(); err != nil || n != 2 {
			t.Fatalf("%s default: %d %v", setting.name, n, err)
		}
		for _, value := range []string{"1", "8"} {
			t.Setenv(setting.name, value)
			if _, err := setting.read(); err != nil {
				t.Fatalf("%s valid %s: %v", setting.name, value, err)
			}
		}
		for _, value := range []string{"0", "9", "invalid"} {
			t.Setenv(setting.name, value)
			if _, err := setting.read(); err == nil {
				t.Fatalf("%s accepted %s", setting.name, value)
			}
		}
	}
}
