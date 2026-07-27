package http

// Tests for the BYOK (bring-your-own-key) HTTP endpoints. The endpoints do not
// call the LLM — /prompts/:name returns the assembled Prompt, /parse/:name
// decodes a caller-supplied raw string. Services are constructed with nil
// clients throughout since the BYOK path never touches Service.client.

import (
	"encoding/json"
	nethttp "net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/zuccamia/career-planner/internal/applications"
	"github.com/zuccamia/career-planner/internal/communications"
	"github.com/zuccamia/career-planner/internal/companies"
	"github.com/zuccamia/career-planner/internal/dossiers"
)

// newBYOKMux builds a minimal mux with just the two BYOK routes so tests can
// exercise r.PathValue("name") the same way the production router does.
func newBYOKMux(s *Server) *nethttp.ServeMux {
	mux := nethttp.NewServeMux()
	mux.HandleFunc("POST /api/llm/prompts/{name}", s.rpcBYOKPrompt)
	mux.HandleFunc("POST /api/llm/parse/{name}", s.rpcBYOKParse)
	return mux
}

// nilServer returns a Server with services that have nil LLM clients. Fine for
// BYOK tests: the BuildXPrompt / FinalizeX pairs don't reference the client.
func nilServer() *Server {
	return &Server{
		companies:      companies.NewService(nil),
		dossiers:       dossiers.NewService(nil),
		applications:   applications.NewService(nil),
		communications: communications.NewService(nil),
	}
}

func doBYOK(t *testing.T, mux *nethttp.ServeMux, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)
	return rr
}

// ---------- /api/llm/server-status ----------

func TestServerStatusAvailable(t *testing.T) {
	s := nilServer()
	s.serverLLMAvailable = true
	s.serverLLMProvider = "openai-compatible"
	s.serverLLMModel = "gpt-4o-mini"
	mux := nethttp.NewServeMux()
	mux.HandleFunc("GET /api/llm/server-status", s.rpcLLMServerStatus)
	req := httptest.NewRequest("GET", "/api/llm/server-status", nil)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)
	if rr.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	var body struct {
		Available bool   `json:"available"`
		Provider  string `json:"provider"`
		Model     string `json:"model"`
	}
	decodeBody(t, rr, &body)
	if !body.Available || body.Provider != "openai-compatible" || body.Model != "gpt-4o-mini" {
		t.Errorf("body = %+v", body)
	}
}

func TestServerStatusUnavailable(t *testing.T) {
	// Zero-value Server → BYOK-only deploy.
	s := nilServer()
	mux := nethttp.NewServeMux()
	mux.HandleFunc("GET /api/llm/server-status", s.rpcLLMServerStatus)
	req := httptest.NewRequest("GET", "/api/llm/server-status", nil)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)
	if rr.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	var body struct {
		Available bool `json:"available"`
	}
	decodeBody(t, rr, &body)
	if body.Available {
		t.Errorf("available should be false when no server-side LLM configured")
	}
}

// ---------- /api/llm/prompts/:name ----------

func TestBYOKPromptUnknownName(t *testing.T) {
	mux := newBYOKMux(nilServer())
	rr := doBYOK(t, mux, "POST", "/api/llm/prompts/does-not-exist", `{}`)
	if rr.Code != nethttp.StatusNotFound {
		t.Fatalf("status = %d, want 404", rr.Code)
	}
}

func TestBYOKPromptBadJSON(t *testing.T) {
	mux := newBYOKMux(nilServer())
	rr := doBYOK(t, mux, "POST", "/api/llm/prompts/guess-candidate", `{not json`)
	if rr.Code != nethttp.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rr.Code)
	}
}

func TestBYOKPromptGuessCandidateSuccess(t *testing.T) {
	mux := newBYOKMux(nilServer())
	rr := doBYOK(t, mux, "POST", "/api/llm/prompts/guess-candidate", `{"name":"Acme"}`)
	if rr.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", rr.Code, rr.Body.String())
	}
	var body struct {
		System string `json:"system"`
		User   string `json:"user"`
	}
	decodeBody(t, rr, &body)
	if body.System == "" || body.User == "" {
		t.Errorf("empty prompt fields (system=%q user=%q)", body.System, body.User)
	}
	if !strings.Contains(body.User, "Acme") {
		t.Errorf("user prompt should mention the name; got %q", body.User)
	}
}

func TestBYOKPromptGuessCandidateEmptyNameRejected(t *testing.T) {
	// Empty name is invalid — matches the server-side endpoint's behavior.
	mux := newBYOKMux(nilServer())
	rr := doBYOK(t, mux, "POST", "/api/llm/prompts/guess-candidate", `{"name":"   "}`)
	if rr.Code != nethttp.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rr.Code)
	}
}

func TestBYOKPromptBuildDossierSuccess(t *testing.T) {
	mux := newBYOKMux(nilServer())
	rr := doBYOK(t, mux, "POST", "/api/llm/prompts/build-dossier", `{"official_name":"Acme","website":"https://acme.example"}`)
	if rr.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", rr.Code, rr.Body.String())
	}
	var body struct{ System, User string }
	decodeBody(t, rr, &body)
	if !strings.Contains(body.User, "Acme") || !strings.Contains(body.User, "acme.example") {
		t.Errorf("user prompt missing company details: %q", body.User)
	}
}

func TestBYOKPromptSummarizeThreadSuccess(t *testing.T) {
	mux := newBYOKMux(nilServer())
	rr := doBYOK(t, mux, "POST", "/api/llm/prompts/summarize-thread",
		`{"thread":{"person_name":"Jane","channel":"email"},"entries":[{"direction":"inbound","content":"hi"}]}`)
	if rr.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", rr.Code, rr.Body.String())
	}
	var body struct{ System, User string }
	decodeBody(t, rr, &body)
	if !strings.Contains(body.User, "Jane") {
		t.Errorf("user prompt should mention Jane; got %q", body.User)
	}
}

func TestBYOKPromptGenerateMessageInvalidGoal(t *testing.T) {
	mux := newBYOKMux(nilServer())
	rr := doBYOK(t, mux, "POST", "/api/llm/prompts/generate-message",
		`{"goal":"bogus","thread":{"person_name":"Jane"}}`)
	if rr.Code != nethttp.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (invalid goal)", rr.Code)
	}
}

func TestBYOKPromptGenerateMessageSuccess(t *testing.T) {
	mux := newBYOKMux(nilServer())
	rr := doBYOK(t, mux, "POST", "/api/llm/prompts/generate-message",
		`{"goal":"outreach","thread":{"person_name":"Jane"}}`)
	if rr.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", rr.Code, rr.Body.String())
	}
	var body struct{ System, User string }
	decodeBody(t, rr, &body)
	if !strings.Contains(body.User, "outreach") {
		t.Errorf("user prompt should include the goal; got %q", body.User)
	}
}

func TestBYOKPromptExtractJDWithRaw(t *testing.T) {
	// When raw text is provided, no URL fetch happens. Response includes the
	// enriched_raw + posting fields so /parse/ can reuse them.
	mux := newBYOKMux(nilServer())
	rr := doBYOK(t, mux, "POST", "/api/llm/prompts/extract-job-description",
		`{"company_name":"Acme","role_title":"SWE","job_description_raw":"work on cool stuff"}`)
	if rr.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", rr.Code, rr.Body.String())
	}
	var body struct {
		System      string          `json:"system"`
		User        string          `json:"user"`
		EnrichedRaw string          `json:"enriched_raw"`
		Posting     json.RawMessage `json:"posting"`
	}
	decodeBody(t, rr, &body)
	if body.EnrichedRaw == "" {
		t.Errorf("enriched_raw should carry the raw text back to /parse/")
	}
	if !strings.Contains(body.User, "cool stuff") {
		t.Errorf("user prompt missing raw description content: %q", body.User)
	}
}

// ---------- /api/llm/parse/:name ----------

func TestBYOKParseUnknownName(t *testing.T) {
	mux := newBYOKMux(nilServer())
	rr := doBYOK(t, mux, "POST", "/api/llm/parse/does-not-exist", `{"raw":"{}"}`)
	if rr.Code != nethttp.StatusNotFound {
		t.Fatalf("status = %d, want 404", rr.Code)
	}
}

func TestBYOKParseGuessCandidateSuccess(t *testing.T) {
	mux := newBYOKMux(nilServer())
	raw := `{"official_name":"Acme Corp","website":"https://acme.example"}`
	body := `{"raw":` + strings.ReplaceAll(mustJSONString(raw), "\n", "") +
		`,"input":{"name":"acme"}}`
	rr := doBYOK(t, mux, "POST", "/api/llm/parse/guess-candidate", body)
	if rr.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", rr.Code, rr.Body.String())
	}
	var out struct {
		Candidate companies.Candidate `json:"candidate"`
	}
	decodeBody(t, rr, &out)
	if out.Candidate.OfficialName != "Acme Corp" {
		t.Errorf("OfficialName = %q, want %q", out.Candidate.OfficialName, "Acme Corp")
	}
}

func TestBYOKParseGuessCandidateStripsMarkdownFences(t *testing.T) {
	// Real models often wrap JSON in ```json … ``` — the parse endpoint must
	// tolerate it (that's what DecodeJSONResponse is for).
	mux := newBYOKMux(nilServer())
	raw := "```json\n{\"official_name\":\"Acme Corp\"}\n```"
	body := `{"raw":` + mustJSONString(raw) + `,"input":{"name":"acme"}}`
	rr := doBYOK(t, mux, "POST", "/api/llm/parse/guess-candidate", body)
	if rr.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", rr.Code, rr.Body.String())
	}
	var out struct {
		Candidate companies.Candidate `json:"candidate"`
	}
	decodeBody(t, rr, &out)
	if out.Candidate.OfficialName != "Acme Corp" {
		t.Errorf("OfficialName = %q, want %q (fences should have been stripped)", out.Candidate.OfficialName, "Acme Corp")
	}
}

func TestBYOKParseGuessCandidateFallbackOnEmptyName(t *testing.T) {
	// FinalizeCandidate uses the input name as fallback when the model returns
	// blank official_name. Same behavior as the server-side GuessCandidate.
	mux := newBYOKMux(nilServer())
	body := `{"raw":"{}","input":{"name":"Acme"}}`
	rr := doBYOK(t, mux, "POST", "/api/llm/parse/guess-candidate", body)
	if rr.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", rr.Code, rr.Body.String())
	}
	var out struct {
		Candidate companies.Candidate `json:"candidate"`
	}
	decodeBody(t, rr, &out)
	if out.Candidate.OfficialName != "Acme" {
		t.Errorf("fallback name = %q, want Acme", out.Candidate.OfficialName)
	}
}

func TestBYOKParseSummarizeThreadTrimsSummary(t *testing.T) {
	mux := newBYOKMux(nilServer())
	body := `{"raw":"{\"summary\":\"  concise  \"}"}`
	rr := doBYOK(t, mux, "POST", "/api/llm/parse/summarize-thread", body)
	if rr.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", rr.Code, rr.Body.String())
	}
	var out map[string]string
	decodeBody(t, rr, &out)
	if out["summary"] != "concise" {
		t.Errorf("summary = %q, want trimmed 'concise'", out["summary"])
	}
}

func TestBYOKParseGenerateMessageTrims(t *testing.T) {
	mux := newBYOKMux(nilServer())
	body := `{"raw":"{\"message\":\"  hey there  \"}"}`
	rr := doBYOK(t, mux, "POST", "/api/llm/parse/generate-message", body)
	if rr.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", rr.Code, rr.Body.String())
	}
	var out map[string]string
	decodeBody(t, rr, &out)
	if out["message"] != "hey there" {
		t.Errorf("message = %q, want trimmed 'hey there'", out["message"])
	}
}

func TestBYOKParseBuildDossierSuccess(t *testing.T) {
	mux := newBYOKMux(nilServer())
	body := `{"raw":"{\"company_summary\":\"Acme makes stuff\"}"}`
	rr := doBYOK(t, mux, "POST", "/api/llm/parse/build-dossier", body)
	if rr.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", rr.Code, rr.Body.String())
	}
	var out struct {
		CompanySummary string `json:"company_summary"`
		Status         string `json:"status"`
	}
	decodeBody(t, rr, &out)
	if out.CompanySummary != "Acme makes stuff" {
		t.Errorf("company_summary = %q", out.CompanySummary)
	}
	if out.Status != "completed" {
		t.Errorf("status = %q, want 'completed'", out.Status)
	}
}

func TestBYOKParseExtractJDReusesEnrichedRaw(t *testing.T) {
	// /parse/ echoes enriched_raw back in job_description_raw so the browser
	// doesn't need a second network hop to see the ATS-enriched text.
	mux := newBYOKMux(nilServer())
	body := `{
		"raw":"{\"role_title\":\"Engineer\"}",
		"input":{"company_name":"Acme","role_title":"SWE"},
		"enriched_raw":"work on cool stuff",
		"posting":{}
	}`
	rr := doBYOK(t, mux, "POST", "/api/llm/parse/extract-job-description", body)
	if rr.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", rr.Code, rr.Body.String())
	}
	var out struct {
		Structured        map[string]any `json:"structured"`
		JobDescriptionRaw string         `json:"job_description_raw"`
	}
	decodeBody(t, rr, &out)
	if out.JobDescriptionRaw != "work on cool stuff" {
		t.Errorf("job_description_raw = %q, want echo of enriched_raw", out.JobDescriptionRaw)
	}
	if out.Structured["role_title"] != "Engineer" {
		t.Errorf("structured.role_title missing; got %v", out.Structured["role_title"])
	}
}

// mustJSONString escapes a Go string for embedding inside a JSON payload.
func mustJSONString(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		panic(err)
	}
	return string(b)
}
