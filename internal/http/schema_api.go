package http

import (
	"encoding/json"
	"net/http"

	"github.com/zuccamia/career-planner/internal/applications"
	"github.com/zuccamia/career-planner/internal/communications"
	"github.com/zuccamia/career-planner/internal/db"
)

// migrationsJSON serves the ordered migration list the browser applies on
// boot. Same slice the Go migrate loop uses, so both sides stay in lockstep.
func (s *Server) migrationsJSON(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	// Browsers may re-fetch on every boot; a short revalidatable cache is
	// cheap and lets the JS layer also fall back to its IndexedDB copy when
	// offline.
	w.Header().Set("Cache-Control", "public, max-age=60")
	_ = json.NewEncoder(w).Encode(db.Migrations())
}

// schemaEnums serves enum constants that don't live in the DDL (statuses,
// channels, etc.) so the browser can read them from the same source as Go.
func (s *Server) schemaEnums(w http.ResponseWriter, r *http.Request) {
	payload := map[string]any{
		"application_statuses":     applications.Statuses,
		"communication_channels":   communications.Channels,
		"communication_directions": communications.Directions,
		"communication_statuses":   communications.Statuses,
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=60")
	_ = json.NewEncoder(w).Encode(payload)
}
