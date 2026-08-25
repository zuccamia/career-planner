package http

// Shared JSON I/O helpers used by every handler in the package.

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"

	"github.com/zuccamia/career-planner/internal/i18n"
	"github.com/zuccamia/career-planner/internal/sources/llm"
)

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("rpc: encode response: %v", err)
	}
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// writeServiceErr logs the service-layer failure and writes the response.
// llm.ErrClientNotConfigured and llm.InputError map to 400; else 502.
func writeServiceErr(w http.ResponseWriter, r *http.Request, name string, err error) {
	if errors.Is(err, llm.ErrClientNotConfigured) {
		writeErr(w, http.StatusBadRequest, i18n.T(i18n.Resolve(r), "settings.ai.error.no_llm_configured"))
		return
	}
	var inputErr *llm.InputError
	if errors.As(err, &inputErr) {
		writeErr(w, http.StatusBadRequest, inputErr.Msg)
		return
	}
	log.Printf("rpc %s: %v", name, err)
	writeErr(w, http.StatusBadGateway, err.Error())
}

// decodeJSON reads r.Body into dst. On decode failure it writes a 400 with a
// stable error string and returns false, so callers can `return` immediately.
// On success returns true with dst populated.
func decodeJSON[T any](r *http.Request, w http.ResponseWriter, dst *T) bool {
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json body")
		return false
	}
	return true
}
