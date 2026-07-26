package http

import (
	"encoding/json"
	nethttp "net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSchemaEnumsIncludesAllExpectedKeys(t *testing.T) {
	s := &Server{}
	req := httptest.NewRequest(nethttp.MethodGet, "/api/db/enums.json", nil)
	rr := httptest.NewRecorder()
	s.schemaEnums(rr, req)

	if rr.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	if ct := rr.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type = %q, want json", ct)
	}
	if cc := rr.Header().Get("Cache-Control"); cc == "" {
		t.Errorf("Cache-Control header missing")
	}

	var payload map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for _, key := range []string{
		"application_statuses",
		"communication_channels",
		"communication_directions",
		"communication_statuses",
	} {
		if _, ok := payload[key]; !ok {
			t.Errorf("missing key %q in enums payload", key)
		}
	}
}

func TestMigrationsJSONReturnsList(t *testing.T) {
	s := &Server{}
	req := httptest.NewRequest(nethttp.MethodGet, "/api/db/migrations.json", nil)
	rr := httptest.NewRecorder()
	s.migrationsJSON(rr, req)

	if rr.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	if ct := rr.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type = %q, want json", ct)
	}
	var payload []map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(payload) == 0 {
		t.Errorf("expected at least one migration entry")
	}
}
