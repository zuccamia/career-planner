package http

// Serves company listing, editing, viewing, and dossier generation pages.

import (
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/ngochoang/career-planner/internal/companies"
	"github.com/ngochoang/career-planner/internal/dossiers"
)

// companiesIndex renders the companies list with engineering note and people counts.
func (s *Server) companiesIndex(w http.ResponseWriter, r *http.Request) {
	companiesList, err := s.companies.List(r.Context())
	if err != nil {
		log.Printf("list companies: %v", err)
		http.Error(w, "could not load companies", http.StatusInternalServerError)
		return
	}

	companyCounts, err := s.engineeringBlogs.ListCompanyCounts(r.Context())
	if err != nil {
		log.Printf("list engineering blog company counts: %v", err)
		http.Error(w, "could not load companies", http.StatusInternalServerError)
		return
	}
	countByCompanyID := make(map[int64]int64, len(companyCounts))
	for _, count := range companyCounts {
		countByCompanyID[count.CompanyID] = count.NoteCount
	}

	peopleCounts, err := s.people.ListCompanyCounts(r.Context())
	if err != nil {
		log.Printf("list people company counts: %v", err)
		http.Error(w, "could not load companies", http.StatusInternalServerError)
		return
	}
	peopleCountByCompanyID := make(map[int64]int64, len(peopleCounts))
	for _, count := range peopleCounts {
		peopleCountByCompanyID[count.CompanyID] = count.PersonCount
	}

	applicationCounts, err := s.applications.ListCompanyCounts(r.Context())
	if err != nil {
		log.Printf("list applications company counts: %v", err)
		http.Error(w, "could not load companies", http.StatusInternalServerError)
		return
	}
	applicationCountByCompanyID := make(map[int64]int64, len(applicationCounts))
	for _, count := range applicationCounts {
		applicationCountByCompanyID[count.CompanyID] = count.ApplicationCount
	}

	companyCards := make([]map[string]any, 0, len(companiesList))
	for _, company := range companiesList {
		companyCards = append(companyCards, map[string]any{
			"ID":           company.ID,
			"OfficialName": company.OfficialName,
			"Website":      company.Website,
			"UpdatedAt":    company.UpdatedAt,
			"NoteCount":    countByCompanyID[company.ID],
			"PersonCount":  peopleCountByCompanyID[company.ID],
			"ApplicationCount": applicationCountByCompanyID[company.ID],
		})
	}
	data := map[string]any{
		"Title":        "Companies",
		"ActiveNav":    "companies",
		"Companies":    companyCards,
		"HasCompanies": len(companiesList) > 0,
	}
	if err := s.render(w, r, "companies_index.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// companyNewForm renders the initial add-company form.
func (s *Server) companyNewForm(w http.ResponseWriter, r *http.Request) {
	data := map[string]any{
		"Title":     "Add company",
		"ActiveNav": "companies",
	}
	if err := s.render(w, r, "company_new.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// companyNewSubmit guesses company details from a submitted name before final confirmation.
func (s *Server) companyNewSubmit(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, "invalid form", http.StatusBadRequest)
		return
	}

	companyName := strings.TrimSpace(r.FormValue("company_name"))
	if companyName == "" {
		data := map[string]any{
			"Title":     "Add company",
			"ActiveNav": "companies",
			"Error":     "Company name is required.",
		}
		if err := s.render(w, r, "company_new.html", data); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
		}
		return
	}
	candidate, err := s.companies.GuessCandidate(r.Context(), companyName)
	if err != nil {
		log.Printf("guess company candidate: %v", err)
	}
	if strings.TrimSpace(candidate.OfficialName) == "" {
		candidate.OfficialName = companyName
	}

	data := map[string]any{
		"Title":        "Confirm company",
		"ActiveNav":    "companies",
		"CompanyName":  companyName,
		"OfficialName": candidate.OfficialName,
		"Website":      candidate.Website,
		"TechBlogURL":  candidate.TechBlogURL,
		"ATSURL":       candidate.ATSURL,
		"ATSProvider":  candidate.ATSProvider,
		"Reasoning":    candidate.Reasoning,
		"HasReasoning": strings.TrimSpace(candidate.Reasoning) != "",
	}
	if err := s.render(w, r, "company_confirm.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// companyCreate persists a confirmed company record from form input.
func (s *Server) companyCreate(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, "invalid form", http.StatusBadRequest)
		return
	}

	officialName := strings.TrimSpace(r.FormValue("official_name"))
	website := strings.TrimSpace(r.FormValue("website"))
	techBlogURL := strings.TrimSpace(r.FormValue("tech_blog_url"))
	atsURL := strings.TrimSpace(r.FormValue("ats_url"))
	atsProvider := strings.TrimSpace(r.FormValue("ats_provider"))

	company, err := s.companies.Create(r.Context(), companies.CreateCompanyInput{
		OfficialName: officialName,
		Website:      website,
		TechBlogURL:  techBlogURL,
		ATSURL:       atsURL,
		ATSProvider:  atsProvider,
	})
	if err == nil {
		http.Redirect(w, r, "/companies/"+strconv.FormatInt(company.ID, 10), http.StatusSeeOther)
		return
	}

	data := map[string]any{
		"Title":        "Confirm company",
		"ActiveNav":    "companies",
		"Error":        err.Error(),
		"OfficialName": officialName,
		"Website":      website,
		"TechBlogURL":  techBlogURL,
		"ATSURL":       atsURL,
		"ATSProvider":  atsProvider,
	}
	if err := s.render(w, r, "company_confirm.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// companyShow renders one company with its latest dossier and engineering blog notes.
func (s *Server) companyShow(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		http.NotFound(w, r)
		return
	}

	company, err := s.companies.GetByID(r.Context(), id)
	if err != nil {
		if errors.Is(err, companies.ErrCompanyNotFound) {
			http.NotFound(w, r)
			return
		}
		log.Printf("get company: %v", err)
		http.Error(w, "could not load company", http.StatusInternalServerError)
		return
	}

	dossier, dossierErr := s.dossiers.GetLatestByCompanyID(r.Context(), id)
	hasDossier := dossierErr == nil
	if dossierErr != nil && !errors.Is(dossierErr, dossiers.ErrDossierNotFound) {
		log.Printf("get dossier: %v", dossierErr)
		http.Error(w, "could not load company", http.StatusInternalServerError)
		return
	}

	notes, err := s.engineeringBlogs.ListByCompanyID(r.Context(), id)
	if err != nil {
		log.Printf("list company engineering blog notes: %v", err)
		http.Error(w, "could not load company", http.StatusInternalServerError)
		return
	}

	data := map[string]any{
		"Title":                    company.OfficialName,
		"ActiveNav":                "companies",
		"Company":                  company,
		"HasWebsite":               company.Website != "",
		"HasTechBlogURL":           company.TechBlogURL != "",
		"HasATSURL":                company.ATSURL != "",
		"HasATSProvider":           company.ATSProvider != "",
		"HasDossier":               hasDossier,
		"Dossier":                  dossier,
		"HasRecentProductLaunches": len(dossier.RecentProductLaunches) > 0,
		"HasCompanyCultureNotes":   len(dossier.CompanyCultureNotes) > 0,
		"HasInternshipSeasons":     len(dossier.InternshipSeasons) > 0,
		"HasInternshipSummary":     strings.TrimSpace(dossier.InternshipSummary) != "",
		"HasLanguages":             len(dossier.MajorTechStacks.Languages) > 0,
		"HasFrontend":              len(dossier.MajorTechStacks.Frontend) > 0,
		"HasBackend":               len(dossier.MajorTechStacks.Backend) > 0,
		"HasInfra":                 len(dossier.MajorTechStacks.Infrastructure) > 0,
		"HasData":                  len(dossier.MajorTechStacks.Data) > 0,
		"HasTooling":               len(dossier.MajorTechStacks.Tooling) > 0,
		"EngineeringBlogs":         notes,
		"HasEngineeringBlogs":      len(notes) > 0,
		"EngineeringBlogCount":     len(notes),
	}
	if err := s.render(w, r, "company_show.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// companyEditForm renders the company edit form for an existing record.
func (s *Server) companyEditForm(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		http.NotFound(w, r)
		return
	}

	company, err := s.companies.GetByID(r.Context(), id)
	if err != nil {
		if errors.Is(err, companies.ErrCompanyNotFound) {
			http.NotFound(w, r)
			return
		}
		log.Printf("get company for edit: %v", err)
		http.Error(w, "could not load company", http.StatusInternalServerError)
		return
	}

	data := map[string]any{
		"Title":        "Edit company",
		"ActiveNav":    "companies",
		"Company":      company,
		"OfficialName": company.OfficialName,
		"Website":      company.Website,
		"TechBlogURL":  company.TechBlogURL,
		"ATSURL":       company.ATSURL,
		"ATSProvider":  company.ATSProvider,
	}
	if err := s.render(w, r, "company_edit.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// companyEditSubmit saves edits to an existing company record.
func (s *Server) companyEditSubmit(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		http.NotFound(w, r)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "invalid form", http.StatusBadRequest)
		return
	}

	officialName := strings.TrimSpace(r.FormValue("official_name"))
	website := strings.TrimSpace(r.FormValue("website"))
	techBlogURL := strings.TrimSpace(r.FormValue("tech_blog_url"))
	atsURL := strings.TrimSpace(r.FormValue("ats_url"))
	atsProvider := strings.TrimSpace(r.FormValue("ats_provider"))

	company, err := s.companies.Update(r.Context(), companies.UpdateCompanyInput{
		ID:           id,
		OfficialName: officialName,
		Website:      website,
		TechBlogURL:  techBlogURL,
		ATSURL:       atsURL,
		ATSProvider:  atsProvider,
	})
	if err == nil {
		http.Redirect(w, r, "/companies/"+strconv.FormatInt(company.ID, 10), http.StatusSeeOther)
		return
	}
	if errors.Is(err, companies.ErrCompanyNotFound) {
		http.NotFound(w, r)
		return
	}

	existing, getErr := s.companies.GetByID(r.Context(), id)
	if getErr != nil {
		log.Printf("get company for edit error state: %v", getErr)
		http.Error(w, "could not load company", http.StatusInternalServerError)
		return
	}

	data := map[string]any{
		"Title":        "Edit company",
		"ActiveNav":    "companies",
		"Error":        err.Error(),
		"Company":      existing,
		"OfficialName": officialName,
		"Website":      website,
		"TechBlogURL":  techBlogURL,
		"ATSURL":       atsURL,
		"ATSProvider":  atsProvider,
	}
	if err := s.render(w, r, "company_edit.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// companyBuildDossier generates and stores a fresh dossier for the selected company.
func (s *Server) companyBuildDossier(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		http.NotFound(w, r)
		return
	}

	company, err := s.companies.GetByID(r.Context(), id)
	if err != nil {
		if errors.Is(err, companies.ErrCompanyNotFound) {
			http.NotFound(w, r)
			return
		}
		log.Printf("get company for dossier: %v", err)
		http.Error(w, "could not load company", http.StatusInternalServerError)
		return
	}

	if _, err := s.dossiers.Build(r.Context(), dossiers.BuildInput{Company: company}); err != nil {
		log.Printf("build dossier: %v", err)
		http.Error(w, "could not build dossier", http.StatusInternalServerError)
		return
	}

	http.Redirect(w, r, "/companies/"+strconv.FormatInt(id, 10), http.StatusSeeOther)
}

// companyDelete removes a company and redirects back to the companies list.
func (s *Server) companyDelete(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		http.NotFound(w, r)
		return
	}

	if err := s.companies.Delete(r.Context(), id); err != nil {
		if errors.Is(err, companies.ErrCompanyNotFound) {
			http.NotFound(w, r)
			return
		}
		log.Printf("delete company: %v", err)
		http.Error(w, "could not delete company", http.StatusInternalServerError)
		return
	}

	http.Redirect(w, r, "/companies", http.StatusSeeOther)
}
