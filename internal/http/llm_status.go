package http

// GET /api/llm/server-status — reports whether the process was booted with
// LLM_* env vars, so the browser can pick between the server-side LLM path
// and BYOK. Same shape as /api/scrape/server-status. Cheap, uncached, no
// rate limit — it does not touch any provider.

import "net/http"

func (s *Server) rpcLLMServerStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"available": s.serverLLMAvailable,
		"provider":  s.serverLLMProvider,
		"model":     s.serverLLMModel,
	})
}
