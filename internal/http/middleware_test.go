package http

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestBasicAuthDisabledWhenPasswordUnset guards the local-dev default:
// no BASIC_AUTH_PASSWORD → the wrapper is a straight passthrough, no 401.
func TestBasicAuthDisabledWhenPasswordUnset(t *testing.T) {
	t.Setenv("BASIC_AUTH_PASSWORD", "")
	h := basicAuth(okHandler())
	req := httptest.NewRequest(http.MethodGet, "/dashboard", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (auth should be off)", rr.Code)
	}
}

// TestBasicAuthRejectsMissingCredentials — password set, request has no
// Authorization header → 401 with a WWW-Authenticate challenge.
func TestBasicAuthRejectsMissingCredentials(t *testing.T) {
	t.Setenv("BASIC_AUTH_PASSWORD", "hunter2")
	h := basicAuth(okHandler())
	req := httptest.NewRequest(http.MethodGet, "/dashboard", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rr.Code)
	}
	if got := rr.Header().Get("WWW-Authenticate"); got == "" {
		t.Error("missing WWW-Authenticate header on 401")
	}
}

func TestBasicAuthRejectsWrongPassword(t *testing.T) {
	t.Setenv("BASIC_AUTH_PASSWORD", "hunter2")
	h := basicAuth(okHandler())
	req := httptest.NewRequest(http.MethodGet, "/dashboard", nil)
	req.SetBasicAuth("anyone", "wrong")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rr.Code)
	}
}

// TestBasicAuthAcceptsAnyUsername confirms the password-only design:
// the username field is present but ignored.
func TestBasicAuthAcceptsAnyUsername(t *testing.T) {
	t.Setenv("BASIC_AUTH_PASSWORD", "hunter2")
	h := basicAuth(okHandler())
	for _, user := range []string{"", "alice", "bob", "🙂"} {
		req := httptest.NewRequest(http.MethodGet, "/dashboard", nil)
		req.SetBasicAuth(user, "hunter2")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Errorf("username=%q: status = %d, want 200", user, rr.Code)
		}
	}
}

// TestBasicAuthBypassesHealth — Cloud Run probes hit /health without
// credentials; the middleware must not gate that path even when auth is on.
func TestBasicAuthBypassesHealth(t *testing.T) {
	t.Setenv("BASIC_AUTH_PASSWORD", "hunter2")
	h := basicAuth(okHandler())
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (health should bypass auth)", rr.Code)
	}
}
