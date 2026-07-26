package http

import (
	nethttp "net/http"
	"net/http/httptest"
	"testing"
)

func TestRootRedirectSendsToDashboard(t *testing.T) {
	s := &Server{}
	req := httptest.NewRequest(nethttp.MethodGet, "/", nil)
	rr := httptest.NewRecorder()
	s.rootRedirect(rr, req)

	if rr.Code != nethttp.StatusFound {
		t.Fatalf("status = %d, want 302", rr.Code)
	}
	if loc := rr.Header().Get("Location"); loc != "/local/dashboard" {
		t.Errorf("Location = %q, want /local/dashboard", loc)
	}
}

func TestRootRedirectNonRootReturns404(t *testing.T) {
	s := &Server{}
	req := httptest.NewRequest(nethttp.MethodGet, "/other", nil)
	rr := httptest.NewRecorder()
	s.rootRedirect(rr, req)

	if rr.Code != nethttp.StatusNotFound {
		t.Fatalf("status = %d, want 404", rr.Code)
	}
}
