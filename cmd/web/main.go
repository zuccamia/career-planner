package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"github.com/zuccamia/career-planner/internal/app"
)

func main() {
	application := app.New()
	// IdleTimeout caps how long keep-alive connections stay idle. Without it
	// Go's default is unlimited — Chromium's shutdown then waits on those
	// sockets during Playwright teardown, which shows up as workers hanging
	// past all-tests-done. 5s is short enough to release cleanly, long enough
	// to reuse across a single page's fetches.
	srv := &http.Server{
		Addr:        application.Addr,
		Handler:     application.Router,
		IdleTimeout: 5 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		log.Printf("starting web server on %s", application.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("graceful shutdown: %v", err)
		return
	}
	log.Print("bye!")
}
