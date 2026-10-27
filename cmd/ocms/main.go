package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"ocms/internal/bff"
	"ocms/internal/catalog"
	"ocms/internal/dbmigrate"
	"ocms/internal/media"
	"ocms/internal/platform"
	"ocms/internal/search"
	"ocms/internal/transfer"
)

func main() {
	if err := run(); err != nil {
		slog.Error("service.failed", "reason", err.Error())
		os.Exit(1)
	}
}
func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if len(os.Args) > 1 && os.Args[1] == "migrate" {
		return dbmigrate.Run(ctx, os.Args[2:])
	}
	name := platform.Env("SERVICE", "bff")
	semanticSearchEnabled, err := strconv.ParseBool(platform.Env("SEMANTIC_SEARCH_ENABLED", "true"))
	if err != nil {
		return errors.New("invalid SEMANTIC_SEARCH_ENABLED: expected boolean")
	}
	shutdown, err := platform.Telemetry(ctx, name)
	if err != nil {
		return err
	}
	defer func() {
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = shutdown(c)
	}()
	max, err := strconv.ParseInt(platform.Env("MAX_UPLOAD_BYTES", "1073741824"), 10, 64)
	if err != nil || max < 0 || max > 1<<50 {
		panic("invalid max upload size")
	}
	var handler http.Handler
	switch name {
	case "catalog":
		db, e := platform.DB(ctx)
		if e != nil {
			return e
		}
		defer db.Close()
		if e = db.Ping(ctx); e != nil {
			return e
		}
		handler = (&catalog.Service{DB: db, MaxSize: max}).Handler()
	case "transfer":
		db, e := platform.DB(ctx)
		if e != nil {
			return e
		}
		defer db.Close()
		s, e := transfer.New(ctx, db, max)
		if e != nil {
			return e
		}
		if len(os.Args) > 1 {
			switch os.Args[1] {
			case "ciphertext-info":
				if len(os.Args) != 3 {
					return errors.New("blob ID required")
				}
				n, digest, e := s.CiphertextInfo(ctx, os.Args[2])
				if e != nil {
					return e
				}
				return json.NewEncoder(os.Stdout).Encode(map[string]any{"size_bytes": n, "sha256": digest})
			case "rewrap":
				return s.Rewrap(ctx)
			case "reconcile":
				return s.Reconcile(ctx)
			}
		}
		go func() {
			timer := time.NewTicker(time.Minute)
			defer timer.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-timer.C:
					if e := s.Reconcile(ctx); e != nil {
						slog.Warn("transfer.reconcile_retry")
					}
				}
			}
		}()
		handler = s.Handler()
	case "worker":
		db, e := platform.DB(ctx)
		if e != nil {
			return e
		}
		defer db.Close()
		s := media.New(db)
		s.SemanticSearchDisabled = !semanticSearchEnabled
		s.ImageOCREnabled, e = strconv.ParseBool(platform.Env("MEDIA_IMAGE_OCR_ENABLED", "false"))
		if e != nil {
			return errors.New("invalid MEDIA_IMAGE_OCR_ENABLED: expected boolean")
		}
		s.Concurrency, e = media.WorkerConcurrency()
		if e != nil {
			return e
		}
		s.PDFPageConcurrency, e = media.PDFPageConcurrency()
		if e != nil {
			return e
		}
		workerCtx, cancelWorkers := context.WithCancel(ctx)
		workersDone := make(chan struct{})
		go func() { defer close(workersDone); s.Run(workerCtx) }()
		defer func() { cancelWorkers(); <-workersDone }()
		handler = s.Handler()
	case "search":
		db, e := platform.DB(ctx)
		if e != nil {
			return e
		}
		defer db.Close()
		s := search.New(db)
		s.SemanticSearchDisabled = !semanticSearchEnabled
		handler = s.Handler()
	case "bff":
		s, e := bff.New(ctx)
		if e != nil {
			return e
		}
		handler = s.Handler(os.DirFS(platform.Env("WEB_DIR", "web/dist")))
	default:
		panic("unknown service")
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	mux.Handle("/", platform.HTTPHandler(name, handler))
	server := &http.Server{Addr: ":8080", Handler: mux, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, ReadTimeout: 10 * time.Minute, WriteTimeout: 10 * time.Minute, MaxHeaderBytes: 32 << 10}
	go func() {
		<-ctx.Done()
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(c)
	}()
	slog.Info("service.started")
	err = server.ListenAndServe()
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}
