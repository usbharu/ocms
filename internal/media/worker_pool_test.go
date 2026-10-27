package media

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

func TestWorkerPoolRunsConcurrentlyAndJoinsOnShutdown(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	started := make(chan struct{}, 2)
	stopped := make(chan struct{})
	var active atomic.Int32
	go func() {
		runWorkerPool(ctx, 2, func(ctx context.Context) error {
			active.Add(1)
			started <- struct{}{}
			<-ctx.Done()
			active.Add(-1)
			return ctx.Err()
		})
		close(stopped)
	}()
	for range 2 {
		select {
		case <-started:
		case <-time.After(5 * time.Second):
			cancel()
			t.Fatal("workers did not run concurrently")
		}
	}
	if active.Load() != 2 {
		t.Fatal("expected two simultaneous workers")
	}
	cancel()
	select {
	case <-stopped:
		if active.Load() != 0 {
			t.Fatal("pool returned before workers stopped")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("workers did not stop")
	}
}
