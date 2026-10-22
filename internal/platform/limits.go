package platform

import (
	"os"
	"strconv"
)

func PositiveIntEnv(name string, fallback, maximum int) int {
	value, err := strconv.Atoi(os.Getenv(name))
	if err != nil || value < 1 || value > maximum {
		return fallback
	}
	return value
}

// Worker and Transfer must agree on which PDF page profiles can be produced.
func PDFPageLimit() int { return PositiveIntEnv("MEDIA_MAX_PDF_PAGES", 500, 10000) }
