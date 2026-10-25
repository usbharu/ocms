package dbmigrate

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRejectUnsafeOrIncompleteConfiguration(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "001_test.up.sql"), []byte("BEGIN; SELECT 1; COMMIT;"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MIGRATIONS_DIR", dir)
	t.Setenv("DATABASE_URL", "invalid://private-credential")
	t.Setenv("APP_DB_PASSWORD", "private-app-password")
	for _, args := range [][]string{nil, {"down"}, {"drop"}, {"up", "extra"}, {"baseline"}, {"baseline", "-1"}, {"force", "private-credential"}, {"force", "-2"}, {"force", "0"}, {"baseline", "2"}, {"up"}} {
		err := Run(context.Background(), args)
		if err == nil {
			t.Fatalf("accepted arguments %v", args)
		}
		if strings.Contains(err.Error(), "private") {
			t.Fatalf("unsafe error text")
		}
	}
}

func TestRejectLegacySQLFilename(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "007_favorites.sql"), []byte("SELECT 1;"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MIGRATIONS_DIR", dir)
	if err := Run(context.Background(), []string{"up"}); err == nil || err.Error() != "MIGRATION_FILENAME_INVALID" {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRepositoryMigrationBundle(t *testing.T) {
	entries, err := os.ReadDir(filepath.Join("..", "..", "migrations"))
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if filepath.Ext(name) != ".sql" {
			continue
		}
		found = true
		if !validFilename(name) {
			t.Fatalf("migration must use the golang-migrate .up.sql or .down.sql convention: %s", name)
		}
		body, err := os.ReadFile(filepath.Join("..", "..", "migrations", name))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(body), `\gexec`) || strings.Contains(string(body), `:'app_password'`) {
			t.Fatalf("psql-only syntax in migration: %s", name)
		}
	}
	if !found {
		t.Fatal("migration bundle is empty")
	}
}
