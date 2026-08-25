package http

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/zuccamia/career-planner/internal/applications"
	"github.com/zuccamia/career-planner/internal/companies"
	"github.com/zuccamia/career-planner/internal/discover"
	"github.com/zuccamia/career-planner/internal/i18n"
	"github.com/zuccamia/career-planner/internal/people"
	"github.com/zuccamia/career-planner/internal/profile"
	"github.com/zuccamia/career-planner/internal/sources/ats"
	"github.com/zuccamia/career-planner/internal/sources/scrape"
)

// Stateless RPC handlers: JSON in, JSON out; no persistence.

// ---- companies ----

// rpcLookupCompany wraps companies.Service.GuessCandidate for the browser client.
func (s *Server) rpcLookupCompany(w http.ResponseWriter, r *http.Request) {
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
		log.Printf("rpc companies/lookup: %v", err)
		writeJSON(w, http.StatusOK, map[string]any{
			"candidate": candidate,
			"warning":   err.Error(),
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"candidate": candidate})
}

// rpcBuildDossier wraps companies.Service.Build for the browser client.
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
	pages := companies.Pages{
		Website: strings.TrimSpace(body.WebsiteContent),
		Blog:    strings.TrimSpace(body.BlogContent),
		Careers: strings.TrimSpace(body.CareersContent),
	}

	if s.serverScrapeAvailable(r.Context()) {
		if website != "" && atsURL == "" {
			if got, prov, err := ats.LookupATSURL(r.Context(), s.scrape, website); err != nil {
				log.Printf("dossier: ats lookup failed for %s: %v", website, err)
			} else if got != "" {
				atsURL = got
				if atsProvider == "" {
					atsProvider = prov
				}
			}
		}
		s.scrapeMissingContent(r.Context(), &pages, website, blogURL, atsURL)
	}

	out, err := s.companies.BuildDossier(r.Context(), companies.Company{
		OfficialName: name,
		Website:      website,
		BlogURL:      blogURL,
		ATSURL:       atsURL,
		ATSProvider:  atsProvider,
	}, body.OutputLanguage, pages)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// scrapeMissingContent scrapes each URL in parallel into pages; skips prefilled slots.
func (s *Server) scrapeMissingContent(ctx context.Context, e *companies.Pages, website, blog, careers string) {
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

// ---- profile ----

// rpcGenerateBragTags wraps profile.Service.GenerateBragTags for the browser.
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
	tags, err := s.profile.GenerateBragTags(r.Context(), body.Body, body.OutputLanguage)
	if err != nil {
		writeServiceErr(w, r, "profile/generate-brag-tags", err)
		return
	}
	writeJSON(w, http.StatusOK, profile.BragTagResult{Tags: tags})
}

// Input: {"markdown":"...","output_language":"en|vi"}. Output: {"brags":[...]}.
func (s *Server) rpcImportBrags(w http.ResponseWriter, r *http.Request) {
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
	entries, err := s.profile.ImportBrags(r.Context(), body.Markdown, body.OutputLanguage)
	if err != nil {
		writeServiceErr(w, r, "profile/import-brags", err)
		return
	}
	writeJSON(w, http.StatusOK, profile.ImportBragsResult{Brags: entries})
}

// Input: {"markdown":"...","output_language":"en|vi"}. Output: profile.ImportedOverview.
func (s *Server) rpcImportOverview(w http.ResponseWriter, r *http.Request) {
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
	overview, err := s.profile.ImportOverview(r.Context(), body.Markdown, body.OutputLanguage)
	if err != nil {
		writeServiceErr(w, r, "profile/import-overview", err)
		return
	}
	writeJSON(w, http.StatusOK, overview)
}

// rpcImportResume wraps profile.Service.ImportResume.
// Input: {"source":"<markdown or typst>","output_language":"en|vi"}. Prompt
// is format-neutral so a single field suffices.
func (s *Server) rpcImportResume(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Source         string `json:"source"`
		OutputLanguage string `json:"output_language"`
	}
	if !decodeJSON(r, w, &body) {
		return
	}
	source := strings.TrimSpace(body.Source)
	if source == "" {
		writeErr(w, http.StatusBadRequest, i18n.T(body.OutputLanguage, "profile.resumes.error.source_required"))
		return
	}
	resume, err := s.profile.ImportResume(r.Context(), source, body.OutputLanguage)
	if err != nil {
		writeServiceErr(w, r, "profile/import-resume", err)
		return
	}
	writeJSON(w, http.StatusOK, resume)
}

// ---- applications ----

// rpcAnalyzeRoleSignals analyzes JD + optional company dossier into a role brief
// the tailor pipeline uses as a rubric. Response: { brief: "<markdown>" }.
func (s *Server) rpcAnalyzeRoleSignals(w http.ResponseWriter, r *http.Request) {
	var in applications.AnalyzeRoleSignalsInput
	if !decodeJSON(r, w, &in) {
		return
	}
	out, err := s.applications.AnalyzeRoleSignals(r.Context(), in)
	if err != nil {
		writeServiceErr(w, r, "applications/analyze-role-signals", err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// rpcTailor runs the composite tailor pipeline: rank per category, take
// top-N, draft the résumé.
func (s *Server) rpcTailor(w http.ResponseWriter, r *http.Request) {
	var in applications.TailorInput
	if !decodeJSON(r, w, &in) {
		return
	}
	out, err := s.applications.Tailor(r.Context(), in)
	if err != nil {
		writeServiceErr(w, r, "tailor", err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// Wire shape shared by summarize/generate-message handlers.
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
func (p threadDetailPayload) toThreadDetail() people.ThreadDetail {
	detail := people.ThreadDetail{
		Thread: people.Thread{
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
		detail.Entries = append(detail.Entries, people.ThreadEntry{
			Direction:  e.Direction,
			Content:    e.Content,
			OccurredAt: occurred,
		})
	}
	return detail
}

// ---- people ----

// rpcSummarizeThread wraps people.Service.SummarizeThreadContext.
// Input: thread + entries payload. Output: {"summary": "..."}. The browser
// owns persistence — this endpoint only runs the LLM prompt.
func (s *Server) rpcSummarizeThread(w http.ResponseWriter, r *http.Request) {
	var body threadDetailPayload
	if !decodeJSON(r, w, &body) {
		return
	}
	summary, err := s.people.SummarizeThreadContext(r.Context(), body.toThreadDetail(), body.OutputLanguage)
	if err != nil {
		log.Printf("rpc people/summarize-thread: %v", err)
		if errors.Is(err, people.ErrUnsafeGeneration) {
			writeErr(w, http.StatusBadRequest, i18n.T(body.OutputLanguage, "people.error.unsafe_summary"))
			return
		}
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"summary": summary})
}

// rpcGenerateMessage wraps people.Service.GenerateMessageFromContext.
// Input: thread + entries + goal ("outreach" | "reply"). Output: {"message"}.
func (s *Server) rpcGenerateMessage(w http.ResponseWriter, r *http.Request) {
	var body struct {
		threadDetailPayload
		Goal string `json:"goal"`
	}
	if !decodeJSON(r, w, &body) {
		return
	}
	message, err := s.people.GenerateMessageFromContext(r.Context(), body.toThreadDetail(), body.Goal, body.OutputLanguage)
	if err != nil {
		log.Printf("rpc people/generate-message: %v", err)
		if errors.Is(err, people.ErrUnsafeGeneration) {
			writeErr(w, http.StatusBadRequest, i18n.T(body.OutputLanguage, "people.error.unsafe_message"))
			return
		}
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"message": message})
}

// rpcExtractJobDescription runs the full server-LLM JD flow: fetch (if raw
// is empty) → prompt → LLM → sanitize. Used by callers without BYOK LLM.
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
	structured, raw, err := s.applications.ExtractJD(r.Context(), applications.JDExtractionInput{
		CompanyName:       body.CompanyName,
		RoleTitle:         body.RoleTitle,
		JobPostingURL:     body.JobPostingURL,
		JobDescriptionRaw: body.JobDescriptionRaw,
		OutputLanguage:    body.OutputLanguage,
	})
	if err != nil {
		writeServiceErr(w, r, "applications/extract-job-description", err)
		return
	}
	// ExtractJD already logs the suspicious-input warning internally; just
	// surface it in the response so the browser can render it.
	writeJSON(w, http.StatusOK, struct {
		Structured        applications.JobDescriptionStructured `json:"structured"`
		JobDescriptionRaw string                                `json:"job_description_raw"`
		Warning           string                                `json:"warning,omitempty"`
	}{Structured: structured, JobDescriptionRaw: raw, Warning: applications.DetectSuspiciousJDInput(raw)})
}

// ---- scrape sidecars ----

// rpcDossierScrape fetches per-page markdown + discovers the ATS URL for a
// dossier. Called by BYOK-LLM browsers with no BYOK scraper; the browser
// runs the LLM itself.
func (s *Server) rpcDossierScrape(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Website        string `json:"website"`
		BlogURL        string `json:"blog_url"`
		ATSURL         string `json:"ats_url"`
		ATSProvider    string `json:"ats_provider"`
		WebsiteContent string `json:"website_content"`
		BlogContent    string `json:"blog_content"`
		CareersContent string `json:"careers_content"`
	}
	if !decodeJSON(r, w, &body) {
		return
	}
	if !s.serverScrapeAvailable(r.Context()) {
		writeErr(w, http.StatusServiceUnavailable, "server scraper is not configured")
		return
	}
	website := strings.TrimSpace(body.Website)
	blogURL := strings.TrimSpace(body.BlogURL)
	atsURL := strings.TrimSpace(body.ATSURL)
	atsProvider := strings.TrimSpace(body.ATSProvider)
	pages := companies.Pages{
		Website: strings.TrimSpace(body.WebsiteContent),
		Blog:    strings.TrimSpace(body.BlogContent),
		Careers: strings.TrimSpace(body.CareersContent),
	}
	if website != "" && atsURL == "" {
		if got, prov, err := ats.LookupATSURL(r.Context(), s.scrape, website); err != nil {
			log.Printf("dossier: ats lookup failed for %s: %v", website, err)
		} else if got != "" {
			atsURL = got
			if atsProvider == "" {
				atsProvider = prov
			}
		}
	}
	s.scrapeMissingContent(r.Context(), &pages, website, blogURL, atsURL)
	writeJSON(w, http.StatusOK, struct {
		ATSURL         string `json:"ats_url"`
		ATSProvider    string `json:"ats_provider"`
		WebsiteContent string `json:"website_content"`
		BlogContent    string `json:"blog_content"`
		CareersContent string `json:"careers_content"`
	}{
		ATSURL: atsURL, ATSProvider: atsProvider,
		WebsiteContent: pages.Website,
		BlogContent:    pages.Blog,
		CareersContent: pages.Careers,
	})
}

// rpcApplicationScrape fetches a job posting via FetchPosting's ladder
// (known ATS → server scraper → generic HTTP) and returns enriched raw text
// + the ats.Posting struct. Called by BYOK-LLM browsers with no BYOK
// scraper; the browser runs the LLM itself.
func (s *Server) rpcApplicationScrape(w http.ResponseWriter, r *http.Request) {
	var body struct {
		JobPostingURL     string `json:"job_posting_url"`
		JobDescriptionRaw string `json:"job_description_raw"`
		OutputLanguage    string `json:"output_language"`
	}
	if !decodeJSON(r, w, &body) {
		return
	}
	raw, posting, err := s.applications.FetchPosting(r.Context(), applications.PostingSource{
		URL:            body.JobPostingURL,
		Raw:            body.JobDescriptionRaw,
		OutputLanguage: body.OutputLanguage,
	})
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, struct {
		EnrichedRaw string      `json:"enriched_raw"`
		Posting     ats.Posting `json:"posting"`
		Warning     string      `json:"warning,omitempty"`
	}{EnrichedRaw: raw, Posting: posting, Warning: applications.DetectSuspiciousJDInput(raw)})
}

// ---- discover ----

// POST /api/discover/run — runs the pipeline against the user's context,
// consuming any browser-precomputed inputs and returning ranked recs.

func (s *Server) rpcDiscoverRun(w http.ResponseWriter, r *http.Request) {
	var req discover.DiscoverRequest
	if !decodeJSON(r, w, &req) {
		return
	}
	resp, err := s.discover.Run(r.Context(), req)
	if err != nil {
		log.Printf("rpc discover run: %v", err)
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// rpcDiscoverSearch runs the search step only. Called by BYOK-LLM browsers
// that don't have BYOK search: expand + rank happen client-side, search
// borrows the server's SearXNG.
func (s *Server) rpcDiscoverSearch(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Query   discover.SearchQuery    `json:"query"`
		Profile discover.ProfileSummary `json:"profile"`
		Locale  string                  `json:"locale"`
	}
	if !decodeJSON(r, w, &body) {
		return
	}
	groups, err := s.discover.Search(r.Context(), body.Query, body.Profile, body.Locale)
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"groups": groups})
}
