package http

// GET /api/scrape/server-status — reports whether the process has a configured
// AND reachable scraper. "Configured" is s.scrape != nil (SCRAPER_* set at
// boot); "reachable" is a live Ping cached in Server.scrapePing.

import (
	"context"
	"net/http"
)

func (s *Server) rpcScrapeServerStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"available": s.serverScrapeAvailable(r.Context()),
		"provider":   s.serverScrapeProvider,
	})
}

// serverScrapeAvailable reports whether the server-side scraper is configured
// (s.scrape != nil) AND currently reachable (cached Ping).
func (s *Server) serverScrapeAvailable(ctx context.Context) bool {
	return s.scrape != nil && s.scrapePing.reachable(ctx, s.scrape.Ping)
}
