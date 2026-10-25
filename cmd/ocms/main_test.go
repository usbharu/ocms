package main

import (
	"strings"
	"testing"
)

func TestRejectInvalidSemanticSearchFlag(t *testing.T) {
	t.Setenv("SEMANTIC_SEARCH_ENABLED", "invalid-value-sentinel")
	err := run()
	if err == nil || !strings.Contains(err.Error(), "SEMANTIC_SEARCH_ENABLED") || strings.Contains(err.Error(), "sentinel") {
		t.Fatalf("invalid configuration not safely rejected: %v", err)
	}
}
