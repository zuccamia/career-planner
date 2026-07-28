package http

// BYOK (bring-your-own-key) HTTP endpoints. The browser calls these when the
// user has configured a personal LLM key. /prompts/:name returns the assembled
// prompt so the browser can call the provider directly; /parse/:name accepts
// the raw model response and returns the same sanitized shape the server-side
// LLM endpoints do. All prompt assembly and sanitization live in the service
// packages (BuildXPrompt / FinalizeX pairs) — this file is only dispatch.
//
// Not rate-limited: neither endpoint calls the LLM. The prompt endpoint may
// trigger an ATS URL fetch for extract-job-description, which reuses the
// SSRF-hardened fetcher the server-side LLM path already runs on.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/zuccamia/career-planner/internal/applications"
	"github.com/zuccamia/career-planner/internal/brags"
	"github.com/zuccamia/career-planner/internal/communications"
	"github.com/zuccamia/career-planner/internal/companies"
	"github.com/zuccamia/career-planner/internal/sources/ats"
	"github.com/zuccamia/career-planner/internal/sources/llm"
)

// rpcLLMServerStatus reports whether this process was started with LLM_* env
// vars (→ non-nil client) so the browser can pick a sidebar-badge state.
// The "Server · <model>" badge shows when this returns available:true; the
// amber "AI: setup needed" badge shows when it returns false and BYOK is
// also unset. Cheap, uncached, no rate limit — it does not touch any provider.
func (s *Server) rpcLLMServerStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"available": s.serverLLMAvailable,
		"provider":  s.serverLLMProvider,
		"model":     s.serverLLMModel,
	})
}

// promptEnvelope is the response shape for /api/llm/prompts/:name for prompts
// that don't need extra pass-through context.
type promptEnvelope struct {
	System string `json:"system"`
	User   string `json:"user"`
}

// jdPromptEnvelope is the response for /api/llm/prompts/extract-job-description.
// enriched_raw and posting travel back to /api/llm/parse/extract-job-description
// so the parse step doesn't re-fetch the ATS posting.
type jdPromptEnvelope struct {
	System      string      `json:"system"`
	User        string      `json:"user"`
	EnrichedRaw string      `json:"enriched_raw"`
	Posting     ats.Posting `json:"posting"`
}

// rpcBYOKPrompt dispatches /api/llm/prompts/:name to the matching BuildXPrompt
// method and returns the assembled prompt for the browser to send to its LLM.
func (s *Server) rpcBYOKPrompt(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	switch name {
	case "guess-candidate":
		var body struct {
			Name string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid json body")
			return
		}
		if strings.TrimSpace(body.Name) == "" {
			writeErr(w, http.StatusBadRequest, "name is required")
			return
		}
		prompt, _, _ := s.companies.BuildCandidatePrompt(body.Name)
		writeJSON(w, http.StatusOK, promptEnvelope{System: prompt.System, User: prompt.User})

	case "build-dossier":
		var body struct {
			OfficialName string `json:"official_name"`
			Website      string `json:"website"`
			ATSURL       string `json:"ats_url"`
			ATSProvider  string `json:"ats_provider"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid json body")
			return
		}
		if strings.TrimSpace(body.OfficialName) == "" {
			writeErr(w, http.StatusBadRequest, "official_name is required")
			return
		}
		prompt := s.dossiers.BuildDossierPrompt(companies.Company{
			OfficialName: strings.TrimSpace(body.OfficialName),
			Website:      strings.TrimSpace(body.Website),
			ATSURL:       strings.TrimSpace(body.ATSURL),
			ATSProvider:  strings.TrimSpace(body.ATSProvider),
		})
		writeJSON(w, http.StatusOK, promptEnvelope{System: prompt.System, User: prompt.User})

	case "generate-brag-tags":
		var body struct {
			Body string `json:"body"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid json body")
			return
		}
		if strings.TrimSpace(body.Body) == "" {
			writeErr(w, http.StatusBadRequest, "body is required")
			return
		}
		prompt := s.brags.BuildGenerateTagsPrompt(body.Body)
		writeJSON(w, http.StatusOK, promptEnvelope{System: prompt.System, User: prompt.User})

	case "summarize-thread":
		var body threadDetailPayload
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid json body")
			return
		}
		prompt := s.communications.BuildSummaryPrompt(body.toThreadDetail())
		writeJSON(w, http.StatusOK, promptEnvelope{System: prompt.System, User: prompt.User})

	case "generate-message":
		var body struct {
			threadDetailPayload
			Goal string `json:"goal"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid json body")
			return
		}
		prompt, err := s.communications.BuildMessagePrompt(body.threadDetailPayload.toThreadDetail(), body.Goal)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, promptEnvelope{System: prompt.System, User: prompt.User})

	case "extract-job-description":
		var body struct {
			CompanyName       string `json:"company_name"`
			RoleTitle         string `json:"role_title"`
			JobPostingURL     string `json:"job_posting_url"`
			JobDescriptionRaw string `json:"job_description_raw"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid json body")
			return
		}
		prep, err := s.applications.PrepareJDExtraction(r.Context(), applications.ExtractJobDescriptionTextInput{
			CompanyName:       body.CompanyName,
			RoleTitle:         body.RoleTitle,
			JobPostingURL:     body.JobPostingURL,
			JobDescriptionRaw: body.JobDescriptionRaw,
		})
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, jdPromptEnvelope{
			System:      prep.Prompt.System,
			User:        prep.Prompt.User,
			EnrichedRaw: prep.EnrichedRaw,
			Posting:     prep.Posting,
		})

	default:
		writeErr(w, http.StatusNotFound, fmt.Sprintf("unknown prompt name %q", name))
	}
}

// rpcBYOKParse dispatches /api/llm/parse/:name. Body is {raw, input, ...} where
// raw is the model response the browser received from its LLM and input is the
// original server-side-endpoint body. For extract-job-description the browser also
// echoes enriched_raw and posting from the prompt response so we don't refetch.
func (s *Server) rpcBYOKParse(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	switch name {
	case "guess-candidate":
		var body struct {
			Raw   string `json:"raw"`
			Input struct {
				Name string `json:"name"`
			} `json:"input"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid json body")
			return
		}
		var candidate companies.Candidate
		if err := llm.DecodeJSONResponse(body.Raw, &candidate); err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		candidate = s.companies.FinalizeCandidate(candidate, body.Input.Name)
		writeJSON(w, http.StatusOK, map[string]any{"candidate": candidate})

	case "build-dossier":
		var body struct {
			Raw string `json:"raw"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid json body")
			return
		}
		// FinalizeDossier operates on the package-private llmResult shape. The
		// dossiers package exposes ParseDossierResponse for this parse step.
		result, err := s.dossiers.ParseAndFinalize(body.Raw)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, result)

	case "generate-brag-tags":
		var body struct {
			Raw string `json:"raw"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid json body")
			return
		}
		var out brags.TagResult
		if err := llm.DecodeJSONResponse(body.Raw, &out); err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, brags.TagResult{Tags: s.brags.FinalizeTags(out)})

	case "summarize-thread":
		var body struct {
			Raw string `json:"raw"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid json body")
			return
		}
		var out communications.SummaryResult
		if err := llm.DecodeJSONResponse(body.Raw, &out); err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"summary": s.communications.FinalizeSummary(out)})

	case "generate-message":
		var body struct {
			Raw string `json:"raw"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid json body")
			return
		}
		var out communications.MessageResult
		if err := llm.DecodeJSONResponse(body.Raw, &out); err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"message": s.communications.FinalizeMessage(out)})

	case "extract-job-description":
		var body struct {
			Raw   string `json:"raw"`
			Input struct {
				CompanyName       string `json:"company_name"`
				RoleTitle         string `json:"role_title"`
				JobPostingURL     string `json:"job_posting_url"`
				JobDescriptionRaw string `json:"job_description_raw"`
			} `json:"input"`
			EnrichedRaw string      `json:"enriched_raw"`
			Posting     ats.Posting `json:"posting"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid json body")
			return
		}
		var out applications.JobDescriptionStructured
		if err := llm.DecodeJSONResponse(body.Raw, &out); err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		input := applications.ExtractJobDescriptionTextInput{
			CompanyName:       body.Input.CompanyName,
			RoleTitle:         body.Input.RoleTitle,
			JobPostingURL:     body.Input.JobPostingURL,
			JobDescriptionRaw: body.Input.JobDescriptionRaw,
		}
		prep := applications.JDExtractionContext{
			EnrichedRaw: body.EnrichedRaw,
			Posting:     body.Posting,
		}
		structured := s.applications.FinalizeJDExtraction(out, input, prep)
		writeJSON(w, http.StatusOK, struct {
			Structured        applications.JobDescriptionStructured `json:"structured"`
			JobDescriptionRaw string                                `json:"job_description_raw"`
		}{Structured: structured, JobDescriptionRaw: body.EnrichedRaw})

	default:
		writeErr(w, http.StatusNotFound, fmt.Sprintf("unknown prompt name %q", name))
	}
}
