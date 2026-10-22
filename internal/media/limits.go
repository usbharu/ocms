package media

import (
	"ocms/internal/platform"
	"time"
)

func pdfPageLimit() int { return platform.PDFPageLimit() }
func jobTimeout() time.Duration {
	return time.Duration(platform.PositiveIntEnv("MEDIA_JOB_TIMEOUT_SECONDS", 7200, 86400)) * time.Second
}
