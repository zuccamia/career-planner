package http

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/zuccamia/career-planner/internal/applications"
	"github.com/zuccamia/career-planner/internal/brags"
	"github.com/zuccamia/career-planner/internal/communications"
	"github.com/zuccamia/career-planner/internal/companies"
	"github.com/zuccamia/career-planner/internal/dossiers"
	"github.com/zuccamia/career-planner/internal/people"
	"github.com/zuccamia/career-planner/internal/sources/ats"
	"github.com/zuccamia/career-planner/internal/sources/llm"
	"github.com/zuccamia/career-planner/internal/sources/scrape"
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

// decodeRawResponse decodes the standard BYOK parse envelope `{raw: "..."}`
// and unmarshals the LLM's raw text into out via llm.DecodeJSONResponse.
// Returns false after writing a 400 (bad envelope) or 502 (bad LLM JSON);
// on success out is populated and returns true.
func decodeRawResponse[T any](r *http.Request, w http.ResponseWriter, out *T) bool {
	var body struct {
		Raw string `json:"raw"`
	}
	if !decodeJSON(r, w, &body) {
		return false
	}
	if err := llm.DecodeJSONResponse(body.Raw, out); err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return false
	}
	return true
}

// rpcGuessCompanyCandidate wraps companies.Service.GuessCandidate for the
// browser client. Input: {"name": "..."}. Output: the Candidate struct.
func (s *Server) rpcGuessCompanyCandidate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name           string `json:"name"`
		OutputLanguage string `json:"output_language"`
	}
	if !decodeJSON(r, w, &body) {
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		writeErr(w, http.StatusBadRequest, "name is required")
		return
	}
	candidate, err := s.companies.GuessCandidate(r.Context(), name, body.OutputLanguage)
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
		OfficialName   string `json:"official_name"`
		Website        string `json:"website"`
		BlogURL        string `json:"blog_url"`
		ATSURL         string `json:"ats_url"`
		ATSProvider    string `json:"ats_provider"`
		OutputLanguage string `json:"output_language"`
		// Optional pre-scraped markdown for each URL. When the caller
		// (browser) has its own BYOK scraper active, it pre-scrapes and
		// passes content here. Empty fields cause the server to scrape
		// itself when a server-side scraper is configured. All non-required.
		WebsiteContent string `json:"website_content"`
		BlogContent    string `json:"blog_content"`
		CareersContent string `json:"careers_content"`
	}
	if !decodeJSON(r, w, &body) {
		return
	}
	name := strings.TrimSpace(body.OfficialName)
	if name == "" {
		writeErr(w, http.StatusBadRequest, "official_name is required")
		return
	}
	website := strings.TrimSpace(body.Website)
	blogURL := strings.TrimSpace(body.BlogURL)
	atsURL := strings.TrimSpace(body.ATSURL)
	atsProvider := strings.TrimSpace(body.ATSProvider)
	enrichment := dossiers.WebsiteEnrichment{
		Website: strings.TrimSpace(body.WebsiteContent),
		Blog:    strings.TrimSpace(body.BlogContent),
		Careers: strings.TrimSpace(body.CareersContent),
	}

	// Server-side scrape fallback: run in parallel for any URL the browser
	// didn't pre-scrape, when a scraper is configured. Best-effort per URL —
	// individual failures are logged and dropped; the dossier still builds
	// from whatever succeeded plus the structured fields.
	if s.scrape != nil {
		s.scrapeMissingIntoEnrichment(r.Context(), &enrichment, website, blogURL, atsURL)
	}

	// Best-effort ATS discovery when the caller didn't supply an ats_url.
	if s.scrape != nil && website != "" && atsURL == "" {
		if got, prov, err := ats.DiscoverATSURL(r.Context(), s.scrape, website); err != nil {
			log.Printf("dossier: ats discovery failed for %s: %v", website, err)
		} else if got != "" {
			atsURL = got
			if atsProvider == "" {
				atsProvider = prov
			}
		}
	}

	out, err := s.dossiers.BuildText(r.Context(), companies.Company{
		OfficialName: name,
		Website:      website,
		BlogURL:      blogURL,
		ATSURL:       atsURL,
		ATSProvider:  atsProvider,
	}, body.OutputLanguage, enrichment)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// scrapeMissingIntoEnrichment scrapes each URL in parallel and writes the
// markdown into the matching enrichment field. Skips URLs already prefilled
// by the browser's BYOK scraper. Per-URL failures are logged.
func (s *Server) scrapeMissingIntoEnrichment(ctx context.Context, e *dossiers.WebsiteEnrichment, website, blog, careers string) {
	var wg sync.WaitGroup
	fanout := func(label, url string, dst *string) {
		if url == "" || *dst != "" {
			return
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.scrapeInto(ctx, label, url, dst)
		}()
	}
	fanout("website", website, &e.Website)
	fanout("blog", blog, &e.Blog)
	fanout("careers", careers, &e.Careers)
	wg.Wait()
}

func (s *Server) scrapeInto(ctx context.Context, label, url string, dst *string) {
	res, err := s.scrape.Scrape(ctx, url, scrape.ScrapeOptions{
		Formats: []string{"markdown"}, OnlyMainContent: true,
	})
	if err != nil {
		log.Printf("dossier: %s scrape failed for %s: %v", label, url, err)
		return
	}
	*dst = res.Markdown
}

// rpcGenerateBragTags wraps brags.Service.GenerateTags for the browser client.
// Input: {"body":"..."}. Output: {"tags":[...]}.
func (s *Server) rpcGenerateBragTags(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Body           string `json:"body"`
		OutputLanguage string `json:"output_language"`
	}
	if !decodeJSON(r, w, &body) {
		return
	}
	if strings.TrimSpace(body.Body) == "" {
		writeErr(w, http.StatusBadRequest, "body is required")
		return
	}
	tags, err := s.brags.GenerateTags(r.Context(), body.Body, body.OutputLanguage)
	if err != nil {
		log.Printf("rpc generate-brag-tags: %v", err)
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, brags.TagResult{Tags: tags})
}

// rpcExtractBragsFromResume wraps brags.Service.ExtractFromResume. The browser
// sends the edited résumé Markdown; the response is a list of candidate brag
// entries the review UI presents for per-entry accept/reject.
// Input: {"markdown":"...","output_language":"en|vi"}. Output: {"brags":[...]}.
func (s *Server) rpcExtractBragsFromResume(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Markdown       string `json:"markdown"`
		OutputLanguage string `json:"output_language"`
	}
	if !decodeJSON(r, w, &body) {
		return
	}
	if strings.TrimSpace(body.Markdown) == "" {
		writeErr(w, http.StatusBadRequest, "markdown is required")
		return
	}
	entries, err := s.brags.ExtractFromResume(r.Context(), body.Markdown, body.OutputLanguage)
	if err != nil {
		log.Printf("rpc extract-brags-from-resume: %v", err)
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, brags.ExtractResumeResult{Brags: entries})
}

// rpcExtractOverviewFromResume wraps profile.Service.ExtractFromResume. The
// browser sends the edited résumé Markdown; the response is a suggested
// overview the user reviews per-field before applying.
// Input: {"markdown":"...","output_language":"en|vi"}.
// Output: the profile.ExtractedOverview struct.
func (s *Server) rpcExtractOverviewFromResume(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Markdown       string `json:"markdown"`
		OutputLanguage string `json:"output_language"`
	}
	if !decodeJSON(r, w, &body) {
		return
	}
	if strings.TrimSpace(body.Markdown) == "" {
		writeErr(w, http.StatusBadRequest, "markdown is required")
		return
	}
	overview, err := s.profile.ExtractFromResume(r.Context(), body.Markdown, body.OutputLanguage)
	if err != nil {
		log.Printf("rpc extract-overview-from-resume: %v", err)
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, overview)
}

// rpcExtractStructuredResumeFromMd wraps profile.Service.ExtractStructuredResume.
// Input: {"markdown":"...","output_language":"en|vi"}.
// Output: the profile.ResumeStructured struct — the browser hands it to a
// deterministic Typst renderer to produce a .typ file.
func (s *Server) rpcExtractStructuredResumeFromMd(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Markdown       string `json:"markdown"`
		OutputLanguage string `json:"output_language"`
	}
	if !decodeJSON(r, w, &body) {
		return
	}
	if strings.TrimSpace(body.Markdown) == "" {
		writeErr(w, http.StatusBadRequest, "markdown is required")
		return
	}
	resume, err := s.profile.ExtractStructuredResume(r.Context(), body.Markdown, body.OutputLanguage)
	if err != nil {
		log.Printf("rpc extract-structured-resume-from-md: %v", err)
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, resume)
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
	OutputLanguage string `json:"output_language"`
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
	if !decodeJSON(r, w, &body) {
		return
	}
	summary, err := s.communications.SummarizeThreadContext(r.Context(), body.toThreadDetail(), body.OutputLanguage)
	if err != nil {
		log.Printf("rpc summarize-thread: %v", err)
		if errors.Is(err, communications.ErrUnsafeGeneration) {
			writeErr(w, http.StatusBadRequest, "Couldn’t safely generate a summary from this thread. Remove prompt-like text and try again.")
			return
		}
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
	if !decodeJSON(r, w, &body) {
		return
	}
	message, err := s.communications.GenerateMessageFromContext(r.Context(), body.threadDetailPayload.toThreadDetail(), body.Goal, body.threadDetailPayload.OutputLanguage)
	if err != nil {
		log.Printf("rpc generate-message: %v", err)
		if errors.Is(err, communications.ErrUnsafeGeneration) {
			writeErr(w, http.StatusBadRequest, "Couldn’t safely generate a draft from this thread. Remove prompt-like text and try again.")
			return
		}
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
		OutputLanguage    string `json:"output_language"`
	}
	if !decodeJSON(r, w, &body) {
		return
	}
	structured, raw, err := s.applications.ExtractJobDescriptionText(r.Context(), applications.ExtractJobDescriptionTextInput{
		CompanyName:       body.CompanyName,
		RoleTitle:         body.RoleTitle,
		JobPostingURL:     body.JobPostingURL,
		JobDescriptionRaw: body.JobDescriptionRaw,
		OutputLanguage:    body.OutputLanguage,
	})
	if err != nil {
		log.Printf("rpc extract-job-description: %v", err)
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	warning := applications.DetectSuspiciousJDInput(raw)
	if warning != "" {
		log.Printf("rpc extract-job-description warning: %s", warning)
	}
	writeJSON(w, http.StatusOK, struct {
		Structured        applications.JobDescriptionStructured `json:"structured"`
		JobDescriptionRaw string                                `json:"job_description_raw"`
		Warning           string                                `json:"warning,omitempty"`
	}{Structured: structured, JobDescriptionRaw: raw, Warning: warning})
}
