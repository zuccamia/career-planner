package http

// GET /api/search/server-status — reports whether the process has a configured
// AND reachable search backend. "Configured" is s.search != nil (SEARCH_BASE_URL
// set at boot); "reachable" is a live Ping cached in Server.searchPing.

import (
	"context"
	"net/http"
)

func (s *Server) rpcSearchServerStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"available": s.serverSearchAvailable(r.Context()),
		"provider":   s.serverSearchProvider,
	})
}

// serverSearchAvailable reports whether the server-side search backend is
// configured (s.search != nil) AND currently reachable (cached Ping).
func (s *Server) serverSearchAvailable(ctx context.Context) bool {
	return s.search != nil && s.searchPing.reachable(ctx, s.search.Ping)
}
