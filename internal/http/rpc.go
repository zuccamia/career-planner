package http

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/ngochoang/career-planner/internal/applications"
	"github.com/ngochoang/career-planner/internal/communications"
	"github.com/ngochoang/career-planner/internal/companies"
	"github.com/ngochoang/career-planner/internal/people"
)

// Stateless RPC endpoints for the local-first browser client. These handlers
// receive JSON, run existing Go business logic (LLM prompts + sanitization),
// and return JSON — no database access. The browser owns all persistent data.

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

// rpcGuessCompanyCandidate wraps companies.Service.GuessCandidate for the
// browser client. Input: {"name": "..."}. Output: the Candidate struct.
func (s *Server) rpcGuessCompanyCandidate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json body")
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		writeErr(w, http.StatusBadRequest, "name is required")
		return
	}
	candidate, err := s.companies.GuessCandidate(r.Context(), name)
	if err != nil {
		// Return the fallback candidate the service produces on LLM failure,
		// with a warning in the body so the UI can surface it.
		log.Printf("rpc guess-candidate: %v", err)
		writeJSON(w, http.StatusOK, map[string]any{
			"candidate": candidate,
			"warning":   err.Error(),
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"candidate": candidate})
}

// rpcBuildDossier wraps dossiers.Service.BuildText for the browser client.
// Input: {official_name, website, ats_url, ats_provider}. Output: the Dossier
// struct (JSON-tagged). No DB access — the browser stores the result locally.
func (s *Server) rpcBuildDossier(w http.ResponseWriter, r *http.Request) {
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
	name := strings.TrimSpace(body.OfficialName)
	if name == "" {
		writeErr(w, http.StatusBadRequest, "official_name is required")
		return
	}
	out := s.dossiers.BuildText(r.Context(), companies.Company{
		OfficialName: name,
		Website:      strings.TrimSpace(body.Website),
		ATSURL:       strings.TrimSpace(body.ATSURL),
		ATSProvider:  strings.TrimSpace(body.ATSProvider),
	})
	// Ignore id/company_id/created/updated — the caller owns those locally.
	out.ID = 0
	out.CompanyID = 0
	writeJSON(w, http.StatusOK, out)
}

// threadDetailPayload matches the JSON shape the browser sends when calling
// the stateless communications RPCs. It maps into a communications.ThreadDetail
// (only the fields buildThreadContext actually reads are populated).
type threadDetailPayload struct {
	Thread struct {
		PersonName  string `json:"person_name"`
		PersonNotes string `json:"person_notes"`
		Channel     string `json:"channel"`
		Subject     string `json:"subject"`
		Status      string `json:"status"`
		Summary     string `json:"summary"`
	} `json:"thread"`
	Entries []struct {
		Direction  string `json:"direction"`
		Content    string `json:"content"`
		OccurredAt string `json:"occurred_at"`
	} `json:"entries"`
}

// toThreadDetail converts the wire payload into the domain type expected by
// buildThreadContext. occurred_at is parsed leniently: RFC3339 first, then
// SQLite's default "YYYY-MM-DD HH:MM:SS", then dropped to zero on failure.
func (p threadDetailPayload) toThreadDetail() communications.ThreadDetail {
	detail := communications.ThreadDetail{
		Thread: communications.Thread{
			Person: people.Person{
				Name:  p.Thread.PersonName,
				Notes: p.Thread.PersonNotes,
			},
			Channel: p.Thread.Channel,
			Subject: p.Thread.Subject,
			Status:  p.Thread.Status,
			Summary: p.Thread.Summary,
		},
	}
	for _, e := range p.Entries {
		occurred, err := time.Parse(time.RFC3339, e.OccurredAt)
		if err != nil {
			occurred, _ = time.Parse("2006-01-02 15:04:05", e.OccurredAt)
		}
		detail.Entries = append(detail.Entries, communications.Entry{
			Direction:  e.Direction,
			Content:    e.Content,
			OccurredAt: occurred,
		})
	}
	return detail
}

// rpcSummarizeThread wraps communications.Service.SummarizeThreadContext.
// Input: thread + entries payload. Output: {"summary": "..."}. The browser
// owns persistence — this endpoint only runs the LLM prompt.
func (s *Server) rpcSummarizeThread(w http.ResponseWriter, r *http.Request) {
	var body threadDetailPayload
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json body")
		return
	}
	summary, err := s.communications.SummarizeThreadContext(r.Context(), body.toThreadDetail())
	if err != nil {
		log.Printf("rpc summarize-thread: %v", err)
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"summary": summary})
}

// rpcGenerateMessage wraps communications.Service.GenerateMessageFromContext.
// Input: thread + entries + goal ("outreach" | "reply"). Output: {"message"}.
func (s *Server) rpcGenerateMessage(w http.ResponseWriter, r *http.Request) {
	var body struct {
		threadDetailPayload
		Goal string `json:"goal"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json body")
		return
	}
	message, err := s.communications.GenerateMessageFromContext(r.Context(), body.threadDetailPayload.toThreadDetail(), body.Goal)
	if err != nil {
		log.Printf("rpc generate-message: %v", err)
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"message": message})
}

// rpcExtractJobDescription wraps applications.Service.ExtractJobDescriptionText.
// Input: {company_name, role_title, job_posting_url, job_description_raw}.
// Output: JobDescriptionStructured JSON.
func (s *Server) rpcExtractJobDescription(w http.ResponseWriter, r *http.Request) {
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
	structured, raw, err := s.applications.ExtractJobDescriptionText(r.Context(), applications.ExtractJobDescriptionTextInput{
		CompanyName:       body.CompanyName,
		RoleTitle:         body.RoleTitle,
		JobPostingURL:     body.JobPostingURL,
		JobDescriptionRaw: body.JobDescriptionRaw,
	})
	if err != nil {
		log.Printf("rpc extract-job-description: %v", err)
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Structured        applications.JobDescriptionStructured `json:"structured"`
		JobDescriptionRaw string                                `json:"job_description_raw"`
	}{Structured: structured, JobDescriptionRaw: raw})
}
