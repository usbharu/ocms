package media

import (
	"fmt"
	"os"
	"strconv"
	"time"

	"ocms/internal/platform"
)

func pdfPageLimit() int { return platform.PDFPageLimit() }
func jobTimeout() time.Duration {
	return time.Duration(platform.PositiveIntEnv("MEDIA_JOB_TIMEOUT_SECONDS", 7200, 86400)) * time.Second
}

func concurrencyEnv(name string, defaultValue int) (int, error) {
	value := os.Getenv(name)
	if value == "" {
		return defaultValue, nil
	}
	count, err := strconv.Atoi(value)
	if err != nil || count < 1 || count > 8 {
		return 0, fmt.Errorf("invalid %s: expected an integer from 1 to 8", name)
	}
	return count, nil
}

// WorkerConcurrency bounds simultaneous Jobs in a single worker process.
func WorkerConcurrency() (int, error) { return concurrencyEnv("MEDIA_WORKER_CONCURRENCY", 2) }

// PDFPageConcurrency bounds concurrent page processing in each PDF Job.
func PDFPageConcurrency() (int, error) { return concurrencyEnv("MEDIA_PDF_PAGE_CONCURRENCY", 2) }
