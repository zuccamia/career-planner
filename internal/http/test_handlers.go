package http

// Exposes test-only endpoints for resetting application state.

import (
	"log"
	"net/http"
	"os"

	"github.com/ngochoang/career-planner/internal/db"
)

// testReset recreates the test database when the server is running in a safe test environment.
func (s *Server) testReset(w http.ResponseWriter, r *http.Request) {
	if s.environment != "test" {
		http.NotFound(w, r)
		return
	}
	if !db.IsSafeTestPath(s.databasePath) {
		log.Printf("refusing test reset for unsafe db path: %s", s.databasePath)
		http.Error(w, "unsafe test database path", http.StatusForbidden)
		return
	}

	if err := db.Reset(r.Context(), s.databasePath); err != nil {
		log.Printf("reset test database: %v", err)
		http.Error(w, "could not reset test database", http.StatusInternalServerError)
		return
	}

	if os.Getenv("DATABASE_PATH") != s.databasePath {
		_ = os.Setenv("DATABASE_PATH", s.databasePath)
	}
	w.WriteHeader(http.StatusNoContent)
}
