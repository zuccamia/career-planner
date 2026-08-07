package http

// Applies shared request handling behavior across routes.

import (
	"crypto/subtle"
	"log"
	"net/http"
	"os"
)

// logging logs the request method and path before passing control to the next handler.
func logging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Printf("%s %s", r.Method, r.URL.Path)
		next.ServeHTTP(w, r)
	})
}

// basicAuth wraps next with HTTP Basic Auth when BASIC_AUTH_PASSWORD is set.
// Unset → the wrapper is a no-op passthrough, so local dev boots wide open;
// Cloud Run gets the gate via the deploy workflow's secret binding.
//
// Password-only by design: the browser's Basic Auth prompt still shows a
// username field per the RFC, but we ignore it — the operator only needs
// to share the password. /health always bypasses so Cloud Run readiness
// probes work. Comparison uses subtle.ConstantTimeCompare against timing
// side-channels.
//
// Env is read once at wrap time (NewRouter). Rotating the password
// requires a restart, which Cloud Run does automatically when the bound
// secret changes.
func basicAuth(next http.Handler) http.Handler {
	pass := os.Getenv("BASIC_AUTH_PASSWORD")
	if pass == "" {
		return next
	}
	passB := []byte(pass)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			next.ServeHTTP(w, r)
			return
		}
		_, p, ok := r.BasicAuth()
		if !ok || subtle.ConstantTimeCompare([]byte(p), passB) != 1 {
			w.Header().Set("WWW-Authenticate", `Basic realm="career-planner"`)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
