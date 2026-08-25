package http

// Shared request-handling middleware: request logging, HTTP Basic Auth gate,
// per-IP rate limiter.

import (
	"crypto/subtle"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// ---- logging ----

// logging logs the request method and path before passing control to the next handler.
func logging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Printf("%s %s", r.Method, r.URL.Path)
		next.ServeHTTP(w, r)
	})
}

// ---- basic auth ----

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

// ---- rate limit ----

// Per-IP token-bucket limiter applied to LLM-touching endpoints to keep the
// shared LLM_API_KEY on the hosted demo from being drained by any one client.

type ipLimiter struct {
	mu       sync.Mutex
	visitors map[string]*visitor
	rate     rate.Limit
	burst    int
	ttl      time.Duration
}

type visitor struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

func newIPLimiter(r rate.Limit, burst int, ttl time.Duration) *ipLimiter {
	return &ipLimiter{
		visitors: make(map[string]*visitor),
		rate:     r,
		burst:    burst,
		ttl:      ttl,
	}
}

// get returns the limiter for ip, creating one on first sight and opportunistically
// evicting entries not seen within ttl. Called under lock.
func (l *ipLimiter) get(ip string) *rate.Limiter {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	if v, ok := l.visitors[ip]; ok {
		v.lastSeen = now
		return v.limiter
	}

	for key, v := range l.visitors {
		if now.Sub(v.lastSeen) > l.ttl {
			delete(l.visitors, key)
		}
	}

	lim := rate.NewLimiter(l.rate, l.burst)
	l.visitors[ip] = &visitor{limiter: lim, lastSeen: now}
	return lim
}

func (l *ipLimiter) middleware(next http.Handler) http.Handler {
	retryAfter := "60"
	if l.rate > 0 {
		retryAfter = strconv.Itoa(int(1.0 / float64(l.rate)))
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := clientIP(r)
		// Loopback callers are the local-first app talking to its own bundled
		// server — the shared-key drain concern doesn't apply, and chunked
		// résumé extraction would otherwise trip the 5 req/min cap.
		if isLoopback(ip) {
			next.ServeHTTP(w, r)
			return
		}
		if !l.get(ip).Allow() {
			w.Header().Set("Retry-After", retryAfter)
			http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func isLoopback(ip string) bool {
	if ip == "" {
		return false
	}
	parsed := net.ParseIP(ip)
	return parsed != nil && parsed.IsLoopback()
}

// clientIP returns the best-effort caller IP. Cloud Run sets X-Forwarded-For
// with the real client at the leftmost position; fall back to RemoteAddr.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if comma := strings.IndexByte(xff, ','); comma >= 0 {
			return strings.TrimSpace(xff[:comma])
		}
		return strings.TrimSpace(xff)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
