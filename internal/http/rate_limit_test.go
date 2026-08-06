package http

import (
	nethttp "net/http"
	"net/http/httptest"
	"testing"
	"time"

	"golang.org/x/time/rate"
)

func newTestLimiter(r rate.Limit, burst int) *ipLimiter {
	return newIPLimiter(r, burst, time.Minute)
}

func doRequest(t *testing.T, h nethttp.Handler, remoteAddr, xff string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(nethttp.MethodPost, "/api/test", nil)
	req.RemoteAddr = remoteAddr
	if xff != "" {
		req.Header.Set("X-Forwarded-For", xff)
	}
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

func okHandler() nethttp.Handler {
	return nethttp.HandlerFunc(func(w nethttp.ResponseWriter, _ *nethttp.Request) {
		w.WriteHeader(nethttp.StatusOK)
	})
}

func TestRateLimiterAllowsUpToBurst(t *testing.T) {
	// rate.Every(time.Hour) makes refill effectively never happen during the test,
	// so we can measure the burst exactly.
	l := newTestLimiter(rate.Every(time.Hour), 3)
	h := l.middleware(okHandler())

	for i := 0; i < 3; i++ {
		if rr := doRequest(t, h, "1.2.3.4:5000", ""); rr.Code != nethttp.StatusOK {
			t.Fatalf("burst request %d: code = %d, want 200", i+1, rr.Code)
		}
	}
	if rr := doRequest(t, h, "1.2.3.4:5000", ""); rr.Code != nethttp.StatusTooManyRequests {
		t.Errorf("post-burst: code = %d, want 429", rr.Code)
	}
}

func TestRateLimiterSets429WithRetryAfter(t *testing.T) {
	l := newTestLimiter(rate.Every(12*time.Second), 1)
	h := l.middleware(okHandler())

	_ = doRequest(t, h, "5.6.7.8:5000", "")
	rr := doRequest(t, h, "5.6.7.8:5000", "")

	if rr.Code != nethttp.StatusTooManyRequests {
		t.Fatalf("code = %d, want 429", rr.Code)
	}
	if ra := rr.Header().Get("Retry-After"); ra == "" || ra == "0" {
		t.Errorf("Retry-After = %q, want a positive integer", ra)
	}
}

func TestRateLimiterIsolatesIPs(t *testing.T) {
	l := newTestLimiter(rate.Every(time.Hour), 1)
	h := l.middleware(okHandler())

	if rr := doRequest(t, h, "10.0.0.1:5000", ""); rr.Code != nethttp.StatusOK {
		t.Fatalf("client A first: %d", rr.Code)
	}
	if rr := doRequest(t, h, "10.0.0.1:5000", ""); rr.Code != nethttp.StatusTooManyRequests {
		t.Fatalf("client A second (should be blocked): %d", rr.Code)
	}
	if rr := doRequest(t, h, "10.0.0.2:5000", ""); rr.Code != nethttp.StatusOK {
		t.Errorf("client B (different IP, should pass): %d", rr.Code)
	}
}

func TestRateLimiterHonorsXForwardedFor(t *testing.T) {
	l := newTestLimiter(rate.Every(time.Hour), 1)
	h := l.middleware(okHandler())

	// Two requests share RemoteAddr (the Cloud Run frontend) but come from
	// different real clients via XFF — must NOT share a bucket.
	if rr := doRequest(t, h, "127.0.0.1:5000", "203.0.113.1"); rr.Code != nethttp.StatusOK {
		t.Fatalf("client via XFF #1: %d", rr.Code)
	}
	if rr := doRequest(t, h, "127.0.0.1:5000", "203.0.113.2"); rr.Code != nethttp.StatusOK {
		t.Errorf("distinct XFF client: %d, want 200", rr.Code)
	}
	// Same XFF as first client → same bucket → 429.
	if rr := doRequest(t, h, "127.0.0.1:5000", "203.0.113.1"); rr.Code != nethttp.StatusTooManyRequests {
		t.Errorf("repeat XFF client: %d, want 429", rr.Code)
	}
}

func TestClientIPPrefersLeftmostXFF(t *testing.T) {
	req := httptest.NewRequest(nethttp.MethodGet, "/", nil)
	req.RemoteAddr = "10.0.0.1:1234"
	req.Header.Set("X-Forwarded-For", "203.0.113.9, 70.41.3.18, 150.172.238.178")

	if got := clientIP(req); got != "203.0.113.9" {
		t.Errorf("clientIP = %q, want 203.0.113.9", got)
	}
}

func TestClientIPFallsBackToRemoteAddr(t *testing.T) {
	req := httptest.NewRequest(nethttp.MethodGet, "/", nil)
	req.RemoteAddr = "198.51.100.7:5000"
	if got := clientIP(req); got != "198.51.100.7" {
		t.Errorf("clientIP = %q, want 198.51.100.7", got)
	}
}

func TestRateLimiterEvictsStaleVisitors(t *testing.T) {
	l := newIPLimiter(rate.Every(time.Hour), 1, 10*time.Millisecond)
	h := l.middleware(okHandler())

	_ = doRequest(t, h, "9.9.9.9:5000", "")
	if rr := doRequest(t, h, "9.9.9.9:5000", ""); rr.Code != nethttp.StatusTooManyRequests {
		t.Fatalf("expected 429 before eviction, got %d", rr.Code)
	}

	time.Sleep(20 * time.Millisecond)
	// Any request forces a lazy sweep; use a fresh IP to avoid touching the
	// stale entry directly before eviction runs.
	_ = doRequest(t, h, "8.8.8.8:5000", "")

	if rr := doRequest(t, h, "9.9.9.9:5000", ""); rr.Code != nethttp.StatusOK {
		t.Errorf("after TTL, stale visitor should get a fresh bucket: got %d, want 200", rr.Code)
	}
}

func TestRateLimiterBypassesLoopback(t *testing.T) {
	// Burst=1, effectively no refill. Loopback should still get through
	// unlimited times because the shared-key drain concern doesn't apply.
	l := newTestLimiter(rate.Every(time.Hour), 1)
	h := l.middleware(okHandler())

	for _, addr := range []string{"127.0.0.1:5000", "127.0.0.1:5001", "[::1]:5000"} {
		for i := 0; i < 5; i++ {
			if rr := doRequest(t, h, addr, ""); rr.Code != nethttp.StatusOK {
				t.Fatalf("loopback %s request %d: code = %d, want 200", addr, i+1, rr.Code)
			}
		}
	}
}
