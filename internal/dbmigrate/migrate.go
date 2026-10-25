// Package dbmigrate adapts OCMS configuration to golang-migrate. Version tracking,
// dirty state, migration execution and database locks belong to the upstream tool.
package dbmigrate

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"time"

	"github.com/golang-migrate/migrate/v4"
	migratepgx "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	"github.com/golang-migrate/migrate/v4/source/file"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

// Run intentionally returns fixed error codes: upstream errors may contain SQL,
// passwords expanded by CREATE ROLE, database URLs or backfill data.
func Run(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return errors.New("MIGRATION_COMMAND_REQUIRED")
	}
	command := args[0]
	if command != "up" && command != "version" && command != "baseline" && command != "force" {
		return errors.New("MIGRATION_COMMAND_INVALID")
	}
	target := 0
	if command == "baseline" || command == "force" {
		if len(args) != 2 {
			return errors.New("MIGRATION_VERSION_REQUIRED")
		}
		var err error
		target, err = strconv.Atoi(args[1])
		if err != nil || target < -1 || (command == "baseline" && target <= 0) {
			return errors.New("MIGRATION_VERSION_INVALID")
		}
	} else if len(args) != 1 {
		return errors.New("MIGRATION_ARGUMENTS_INVALID")
	}
	directory := os.Getenv("MIGRATIONS_DIR")
	if directory == "" {
		directory = "migrations"
	}
	path, err := filepath.Abs(directory)
	if err != nil {
		return errors.New("MIGRATION_SOURCE_INVALID")
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return errors.New("MIGRATION_SOURCE_INVALID")
	}
	// Refuse legacy .sql names instead of silently omitting an unapplied migration.
	for _, entry := range entries {
		name := entry.Name()
		if filepath.Ext(name) == ".sql" && !entry.IsDir() && !validFilename(name) {
			return errors.New("MIGRATION_FILENAME_INVALID")
		}
	}
	source, err := (&file.File{}).Open((&url.URL{Scheme: "file", Path: path}).String())
	if err != nil {
		return errors.New("MIGRATION_SOURCE_INVALID")
	}
	defer source.Close()
	last, err := source.First()
	if err != nil {
		return errors.New("MIGRATION_SOURCE_EMPTY")
	}
	for {
		next, e := source.Next(last)
		if errors.Is(e, os.ErrNotExist) || errors.Is(e, io.EOF) {
			break
		}
		if e != nil {
			return errors.New("MIGRATION_SOURCE_INVALID")
		}
		last = next
	}
	if command == "baseline" || command == "force" {
		if target >= 0 {
			body, _, e := source.ReadUp(uint(target))
			if e != nil {
				return errors.New("MIGRATION_VERSION_UNKNOWN")
			}
			body.Close()
		}
	}
	cfg, err := pgx.ParseConfig(os.Getenv("DATABASE_URL"))
	if err != nil || os.Getenv("DATABASE_URL") == "" {
		return errors.New("MIGRATION_DATABASE_CONFIG_INVALID")
	}
	cfg.ConnectTimeout = 10 * time.Second
	// PostgreSQL error CONTEXT can expand CREATE ROLE passwords, even when the
	// caller redacts driver errors. Keep this admin session's server logs private too.
	cfg.RuntimeParams["log_error_verbosity"] = "terse"
	cfg.RuntimeParams["log_parameter_max_length"] = "0"
	cfg.RuntimeParams["log_parameter_max_length_on_error"] = "0"
	db := stdlib.OpenDB(*cfg)
	defer db.Close()
	// Keep the session setting on the connection leased by the migrate driver.
	db.SetMaxOpenConns(1)
	if command == "up" {
		password := os.Getenv("APP_DB_PASSWORD")
		if password == "" {
			return errors.New("MIGRATION_APP_PASSWORD_REQUIRED")
		}
		if _, err = db.ExecContext(ctx, `SELECT set_config('ocms.app_db_password',$1,false)`, password); err != nil {
			return errors.New("MIGRATION_DATABASE_UNAVAILABLE")
		}
	}
	var legacy, tracked, baselineReady bool
	if err = db.QueryRowContext(ctx, `SELECT to_regnamespace('catalog') IS NOT NULL OR to_regnamespace('storage') IS NOT NULL,to_regclass('public.schema_migrations') IS NOT NULL,to_regclass('catalog.assets') IS NOT NULL AND to_regclass('storage.blobs') IS NOT NULL`).Scan(&legacy, &tracked, &baselineReady); err != nil {
		return errors.New("MIGRATION_DATABASE_UNAVAILABLE")
	}
	if tracked {
		if err = db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM public.schema_migrations)`).Scan(&tracked); err != nil {
			return errors.New("MIGRATION_HISTORY_INVALID")
		}
	}
	if command == "up" && legacy && !tracked {
		return errors.New("MIGRATION_BASELINE_REQUIRED")
	}
	if command == "baseline" && (!baselineReady || tracked) {
		return errors.New("MIGRATION_BASELINE_NOT_ALLOWED")
	}
	driver, err := migratepgx.WithInstance(db, &migratepgx.Config{SchemaName: "public"})
	if err != nil {
		return errors.New("MIGRATION_DRIVER_FAILED")
	}
	runner, err := migrate.NewWithInstance("file", source, "pgx5", driver)
	if err != nil {
		driver.Close()
		return errors.New("MIGRATION_DRIVER_FAILED")
	}
	defer runner.Close()
	runner.LockTimeout = 60 * time.Second
	stop := context.AfterFunc(ctx, func() { runner.GracefulStop <- true })
	defer stop()
	switch command {
	case "up":
		version, _, e := runner.Version()
		if e != nil && !errors.Is(e, migrate.ErrNilVersion) {
			return errors.New("MIGRATION_HISTORY_INVALID")
		}
		if e == nil && version > last {
			return errors.New("MIGRATION_DATABASE_NEWER_THAN_IMAGE")
		}
		err = runner.Up()
	case "baseline", "force":
		err = runner.Force(target)
	}
	if ctx.Err() != nil {
		return errors.New("MIGRATION_INTERRUPTED")
	}
	if err != nil && !errors.Is(err, migrate.ErrNoChange) {
		var dirty migrate.ErrDirty
		if errors.As(err, &dirty) {
			return errors.New("MIGRATION_DIRTY")
		}
		if errors.Is(err, migrate.ErrLockTimeout) {
			return errors.New("MIGRATION_LOCK_TIMEOUT")
		}
		return errors.New("MIGRATION_SQL_FAILED")
	}
	version, dirty, err := runner.Version()
	if errors.Is(err, migrate.ErrNilVersion) {
		slog.InfoContext(ctx, "migration.version", "version", 0, "dirty", false)
		return nil
	}
	if err != nil {
		return errors.New("MIGRATION_HISTORY_INVALID")
	}
	slog.InfoContext(ctx, "migration.completed", "command", command, "version", version, "dirty", dirty)
	return nil
}

var filenamePattern = regexp.MustCompile(`^[0-9]+_[a-z0-9_]+\.(up|down)\.sql$`)

func validFilename(name string) bool { return filenamePattern.MatchString(name) }
