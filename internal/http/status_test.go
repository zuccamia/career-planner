package http

import (
	"context"
	nethttp "net/http"
	"net/http/httptest"
	"testing"

	"github.com/zuccamia/career-planner/internal/sources/search"
)

// ---- llm ----

func TestLLMStatus_Available(t *testing.T) {
	s := nilServer()
	s.serverLLMAvailable = true
	s.serverLLMProvider = "openai-compatible"
	s.serverLLMModel = "gpt-4o-mini"
	mux := nethttp.NewServeMux()
	mux.HandleFunc("GET /api/llm/server-status", s.rpcLLMServerStatus)
	req := httptest.NewRequest("GET", "/api/llm/server-status", nil)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)
	if rr.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	var body struct {
		Available bool   `json:"available"`
		Provider  string `json:"provider"`
		Model     string `json:"model"`
	}
	decodeBody(t, rr, &body)
	if !body.Available || body.Provider != "openai-compatible" || body.Model != "gpt-4o-mini" {
		t.Errorf("body = %+v", body)
	}
}

func TestLLMStatus_Unavailable(t *testing.T) {
	s := nilServer()
	mux := nethttp.NewServeMux()
	mux.HandleFunc("GET /api/llm/server-status", s.rpcLLMServerStatus)
	req := httptest.NewRequest("GET", "/api/llm/server-status", nil)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)
	if rr.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	var body struct {
		Available bool `json:"available"`
	}
	decodeBody(t, rr, &body)
	if body.Available {
		t.Errorf("available should be false when no server-side LLM configured")
	}
}

// ---- discover ----

// Regression: /api/discover/server-status reports llm_available and
// search_available piece-wise so the browser can combine with BYOK state.
// The old "combined-only" shape hid Discover for BYOK-LLM + server-search
// users.

type fakeSearch struct{}

func (fakeSearch) Provider() string           { return "fake-search" }
func (fakeSearch) Ping(context.Context) error { return nil }
func (fakeSearch) Search(context.Context, string, search.Options) ([]search.Result, error) {
	return nil, nil
}

func serveDiscoverStatus(t *testing.T, s *Server) map[string]any {
	t.Helper()
	mux := nethttp.NewServeMux()
	mux.HandleFunc("GET /api/discover/server-status", s.rpcDiscoverServerStatus)
	req := httptest.NewRequest("GET", "/api/discover/server-status", nil)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)
	if rr.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	var body map[string]any
	decodeBody(t, rr, &body)
	return body
}

func TestDiscoverStatus_ServerSearchOnly(t *testing.T) {
	s := nilServer()
	s.search = fakeSearch{}
	s.serverSearchProvider = "searxng"
	body := serveDiscoverStatus(t, s)
	if body["available"].(bool) {
		t.Errorf("available should be false when server LLM is missing")
	}
	if !body["search_available"].(bool) {
		t.Errorf("search_available should be true")
	}
	if body["llm_available"].(bool) {
		t.Errorf("llm_available should be false")
	}
	if body["provider"].(string) != "searxng" {
		t.Errorf("provider = %v, want searxng", body["provider"])
	}
}

func TestDiscoverStatus_ServerLLMOnly(t *testing.T) {
	s := nilServer()
	s.serverLLMAvailable = true
	body := serveDiscoverStatus(t, s)
	if body["available"].(bool) {
		t.Errorf("available should be false when server search is missing")
	}
	if !body["llm_available"].(bool) {
		t.Errorf("llm_available should be true")
	}
	if body["search_available"].(bool) {
		t.Errorf("search_available should be false")
	}
}

func TestDiscoverStatus_BothServer(t *testing.T) {
	s := nilServer()
	s.serverLLMAvailable = true
	s.search = fakeSearch{}
	body := serveDiscoverStatus(t, s)
	if !body["available"].(bool) {
		t.Errorf("available should be true when both sides are up")
	}
}
