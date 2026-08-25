package http

// Server-status endpoints for the three external sources (LLM, scrape, search).
// The browser polls these to decide between server-driven and BYOK paths.
// Cheap and uncached at the handler level; reachability probes use cached
// Pings on Server.{scrape,search}Ping.

import (
	"context"
	"net/http"
)

// ---- llm ----

// GET /api/llm/server-status — reports whether the process was booted with
// LLM_* env vars, so the browser can pick between the server-side LLM path
// and BYOK. No provider round-trip; config-only.
func (s *Server) rpcLLMServerStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"available": s.serverLLMAvailable,
		"provider":  s.serverLLMProvider,
		"model":     s.serverLLMModel,
	})
}

// ---- scrape ----

// GET /api/scrape/server-status — reports whether the process has a configured
// AND reachable scraper. "Configured" is s.scrape != nil (SCRAPER_* set at
// boot); "reachable" is a live Ping cached in Server.scrapePing.
func (s *Server) rpcScrapeServerStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"available": s.serverScrapeAvailable(r.Context()),
		"provider":  s.serverScrapeProvider,
	})
}

// serverScrapeAvailable reports whether the server-side scraper is configured
// (s.scrape != nil) AND currently reachable (cached Ping).
func (s *Server) serverScrapeAvailable(ctx context.Context) bool {
	return s.scrape != nil && s.scrapePing.reachable(ctx, s.scrape.Ping)
}

// ---- search ----

// GET /api/search/server-status — reports whether the process has a configured
// AND reachable search backend. "Configured" is s.search != nil (SEARCH_BASE_URL
// set at boot); "reachable" is a live Ping cached in Server.searchPing.
func (s *Server) rpcSearchServerStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"available": s.serverSearchAvailable(r.Context()),
		"provider":  s.serverSearchProvider,
	})
}

// serverSearchAvailable reports whether the server-side search backend is
// configured (s.search != nil) AND currently reachable (cached Ping).
func (s *Server) serverSearchAvailable(ctx context.Context) bool {
	return s.search != nil && s.searchPing.reachable(ctx, s.search.Ping)
}

// ---- discover ----

// GET /api/discover/server-status — reports whether the full server-side
// Discover pipeline is wired up (server LLM + reachable search). The dashboard
// uses it to hide the Discover button when the server can't run end-to-end.
// BYOK paths can still succeed by supplying browser-computed inputs
// (browser_hits, etc.) to /run.
func (s *Server) rpcDiscoverServerStatus(w http.ResponseWriter, r *http.Request) {
	searchOK := s.serverSearchAvailable(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{
		// available is the fully-server case (both server LLM and server search).
		// The browser combines these piece-wise with BYOK state to decide
		// whether to enable Discover — a BYOK LLM + server search deploy still
		// works via discoverOnServer with browser-driven LLM stages.
		"available":        s.serverLLMAvailable && searchOK,
		"llm_available":    s.serverLLMAvailable,
		"search_available": searchOK,
		"provider":         s.serverSearchProvider,
	})
}
