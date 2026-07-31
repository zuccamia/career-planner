package http

// GET /api/scrape/server-status — reports whether the process was booted with
// SCRAPER_* env vars, so the settings UI and sidebar badge can show whether
// scraping works out of the box or needs BYOK setup. Same shape as
// /api/llm/server-status.

import "net/http"

func (s *Server) rpcScrapeServerStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"available": s.serverScrapeAvailable,
		"backend":   s.serverScrapeBackend,
	})
}
