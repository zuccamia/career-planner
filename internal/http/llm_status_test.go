package http

import (
	nethttp "net/http"
	"net/http/httptest"
	"testing"
)

func TestServerStatusAvailable(t *testing.T) {
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

func TestServerStatusUnavailable(t *testing.T) {
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
