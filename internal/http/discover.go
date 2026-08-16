package http

// GET /api/discover/server-status — reports whether the full server-side
// Discover pipeline is wired up (server LLM + reachable search). The dashboard
// uses it to hide the Discover button when the server can't run end-to-end.
// BYOK paths can still succeed by supplying browser-computed inputs
// (browser_hits, etc.) to /run.
//
// POST /api/discover/run — runs the pipeline against the user's context,
// consuming any browser-precomputed inputs and returning ranked recs.

import (
	"context"
	"log"
	"net/http"

	"github.com/zuccamia/career-planner/internal/discover"
)

func (s *Server) rpcDiscoverServerStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"available": s.serverDiscoverAvailable(r.Context()),
		"provider":   s.serverSearchProvider,
	})
}

// serverDiscoverAvailable reports whether the full server-side Discover
// pipeline is currently usable: server LLM configured AND the search
// subsystem is available (configured + reachable).
func (s *Server) serverDiscoverAvailable(ctx context.Context) bool {
	return s.serverLLMAvailable && s.serverSearchAvailable(ctx)
}

func (s *Server) rpcDiscoverRun(w http.ResponseWriter, r *http.Request) {
	var req discover.DiscoverRequest
	if !decodeJSON(r, w, &req) {
		return
	}
	resp, err := s.discover.Run(r.Context(), req)
	if err != nil {
		log.Printf("rpc discover run: %v", err)
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// rpcDiscoverSearch runs the search step only. Called by BYOK-LLM browsers
// that don't have BYOK search: expand + rank happen client-side, search
// borrows the server's SearXNG.
func (s *Server) rpcDiscoverSearch(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Signals discover.SearchSignals  `json:"signals"`
		Profile discover.ProfileSummary `json:"profile"`
		Locale  string                  `json:"locale"`
	}
	if !decodeJSON(r, w, &body) {
		return
	}
	groups, err := s.discover.Search(r.Context(), body.Signals, body.Profile, body.Locale)
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"groups": groups})
}
