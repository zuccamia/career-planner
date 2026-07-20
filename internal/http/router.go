package http

import (
	"errors"
	"html/template"
	"log"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/ngochoang/career-planner/internal/companies"
	"github.com/ngochoang/career-planner/internal/dossiers"
	"github.com/ngochoang/career-planner/internal/people"
)

type Server struct {
	companies *companies.Service
	dossiers  *dossiers.Service
	people    *people.Service
}

func NewRouter(companiesService *companies.Service, dossiersService *dossiers.Service, peopleService *people.Service) http.Handler {
	server := &Server{
		companies: companiesService,
		dossiers:  dossiersService,
		people:    peopleService,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /", server.home)
	mux.HandleFunc("GET /companies", server.companiesIndex)
	mux.HandleFunc("GET /companies/new", server.companyNewForm)
	mux.HandleFunc("POST /companies/new", server.companyNewSubmit)
	mux.HandleFunc("POST /companies", server.companyCreate)
	mux.HandleFunc("GET /companies/{id}", server.companyShow)
	mux.HandleFunc("GET /companies/{id}/edit", server.companyEditForm)
	mux.HandleFunc("POST /companies/{id}/edit", server.companyEditSubmit)
	mux.HandleFunc("POST /companies/{id}/delete", server.companyDelete)
	mux.HandleFunc("POST /companies/{id}/dossier", server.companyBuildDossier)
	mux.HandleFunc("GET /people", server.peopleIndex)
	mux.HandleFunc("GET /people/new", server.personNewForm)
	mux.HandleFunc("POST /people", server.personCreate)
	mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServer(http.Dir("web/static"))))
	return logging(mux)
}

func parseTemplates(names ...string) (*template.Template, error) {
	paths := make([]string, 0, len(names))
	for _, name := range names {
		paths = append(paths, filepath.Join("web", "templates", name))
	}
	tmpl, err := template.New("base").ParseFiles(paths...)
	if err != nil {
		return nil, err
	}
	return tmpl, nil
}

func (s *Server) home(w http.ResponseWriter, r *http.Request) {
	companiesList, err := s.companies.List(r.Context())
	if err != nil {
		log.Printf("list companies: %v", err)
		http.Error(w, "could not load dashboard", http.StatusInternalServerError)
		return
	}

	companiesWithDossier := 0
	for _, company := range companiesList {
		if _, err := s.dossiers.GetLatestByCompanyID(r.Context(), company.ID); err == nil {
			companiesWithDossier++
		} else if !errors.Is(err, dossiers.ErrDossierNotFound) {
			log.Printf("get dossier for dashboard: %v", err)
			http.Error(w, "could not load dashboard", http.StatusInternalServerError)
			return
		}
	}

	recentCompanies := companiesList
	if len(recentCompanies) > 5 {
		recentCompanies = recentCompanies[:5]
	}

	data := map[string]any{
		"Title":                   "Career Planner",
		"ActiveNav":               "home",
		"ApplicationsCount":       0,
		"InterviewsCount":         0,
		"OffersCount":             0,
		"RejectionsCount":         0,
		"TotalCompanies":          len(companiesList),
		"CompaniesWithDossier":    companiesWithDossier,
		"CompaniesWithoutDossier": len(companiesList) - companiesWithDossier,
		"RecentCompanies":         recentCompanies,
		"HasRecentCompanies":      len(recentCompanies) > 0,
	}
	if err := s.render(w, r, "index.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func (s *Server) companiesIndex(w http.ResponseWriter, r *http.Request) {
	companiesList, err := s.companies.List(r.Context())
	if err != nil {
		log.Printf("list companies: %v", err)
		http.Error(w, "could not load companies", http.StatusInternalServerError)
		return
	}

	data := map[string]any{
		"Title":        "Companies",
		"ActiveNav":    "companies",
		"Companies":    companiesList,
		"HasCompanies": len(companiesList) > 0,
	}
	if err := s.render(w, r, "companies_index.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func (s *Server) peopleIndex(w http.ResponseWriter, r *http.Request) {
	peopleList, err := s.people.List(r.Context())
	if err != nil {
		log.Printf("list people: %v", err)
		http.Error(w, "could not load people", http.StatusInternalServerError)
		return
	}

	data := map[string]any{
		"Title":     "People",
		"ActiveNav": "people",
		"People":    peopleList,
		"HasPeople": len(peopleList) > 0,
	}
	if err := s.render(w, r, "people_index.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func (s *Server) personNewForm(w http.ResponseWriter, r *http.Request) {
	companiesList, err := s.companies.List(r.Context())
	if err != nil {
		log.Printf("list companies for person form: %v", err)
		http.Error(w, "could not load people form", http.StatusInternalServerError)
		return
	}

	data := map[string]any{
		"Title":        "Add person",
		"ActiveNav":    "people",
		"Companies":    companiesList,
		"HasCompanies": len(companiesList) > 0,
	}
	if err := s.render(w, r, "person_new.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func (s *Server) personCreate(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, "invalid form", http.StatusBadRequest)
		return
	}

	companyID, _ := strconv.ParseInt(strings.TrimSpace(r.FormValue("company_id")), 10, 64)
	person, err := s.people.Create(r.Context(), people.CreatePersonInput{
		FullName:    r.FormValue("full_name"),
		Title:       r.FormValue("title"),
		CompanyID:   companyID,
		LinkedInURL: r.FormValue("linkedin_url"),
		Notes:       r.FormValue("notes"),
	})
	if err == nil {
		http.Redirect(w, r, "/people", http.StatusSeeOther)
		_ = person
		return
	}

	companiesList, listErr := s.companies.List(r.Context())
	if listErr != nil {
		log.Printf("list companies for person form error state: %v", listErr)
		http.Error(w, "could not load people form", http.StatusInternalServerError)
		return
	}

	data := map[string]any{
		"Title":             "Add person",
		"ActiveNav":         "people",
		"Error":             err.Error(),
		"Companies":         companiesList,
		"HasCompanies":      len(companiesList) > 0,
		"FullName":          strings.TrimSpace(r.FormValue("full_name")),
		"PersonTitle":       strings.TrimSpace(r.FormValue("title")),
		"SelectedCompanyID": companyID,
		"LinkedInURL":       strings.TrimSpace(r.FormValue("linkedin_url")),
		"Notes":             strings.TrimSpace(r.FormValue("notes")),
	}
	if err := s.render(w, r, "person_new.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func (s *Server) companyNewForm(w http.ResponseWriter, r *http.Request) {
	data := map[string]any{
		"Title":     "Add company",
		"ActiveNav": "companies",
	}
	if err := s.render(w, r, "company_new.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

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
	note := "Please review and edit before continuing."
	if err != nil {
		log.Printf("guess company candidate: %v", err)
		note = "Could not verify automatically — please edit the details directly."
	}

	data := map[string]any{
		"Title":         "Company candidate",
		"ActiveNav":     "companies",
		"CompanyName":   companyName,
		"SubmittedName": companyName,
		"OfficialName":  candidate.OfficialName,
		"Website":       candidate.Website,
		"TechBlogURL":   candidate.TechBlogURL,
		"ATSURL":        candidate.ATSURL,
		"ATSProvider":   candidate.ATSProvider,
		"Confidence":    candidate.Confidence,
		"Reasoning":     candidate.Reasoning,
		"Note":          note,
	}
	if err := s.render(w, r, "company_confirm.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func (s *Server) companyCreate(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, "invalid form", http.StatusBadRequest)
		return
	}

	submittedName := strings.TrimSpace(r.FormValue("submitted_name"))
	officialName := strings.TrimSpace(r.FormValue("official_name"))
	website := strings.TrimSpace(r.FormValue("website"))
	techBlogURL := strings.TrimSpace(r.FormValue("tech_blog_url"))
	atsURL := strings.TrimSpace(r.FormValue("ats_url"))
	atsProvider := strings.TrimSpace(r.FormValue("ats_provider"))

	if submittedName == "" {
		data := map[string]any{
			"Title":         "Confirm company",
			"ActiveNav":     "companies",
			"Error":         "Submitted company name is required.",
			"SubmittedName": submittedName,
			"OfficialName":  officialName,
			"Website":       website,
			"TechBlogURL":   techBlogURL,
			"ATSURL":        atsURL,
			"ATSProvider":   atsProvider,
		}
		if err := s.render(w, r, "company_confirm.html", data); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
		}
		return
	}

	company, err := s.companies.Create(r.Context(), companies.CreateCompanyInput{
		SubmittedName: submittedName,
		OfficialName:  officialName,
		Website:       website,
		TechBlogURL:   techBlogURL,
		ATSURL:        atsURL,
		ATSProvider:   atsProvider,
	})
	if err != nil {
		log.Printf("create company: %v", err)
		data := map[string]any{
			"Title":         "Company candidate",
			"ActiveNav":     "companies",
			"Error":         "Could not save the company. Please review the details and try again.",
			"SubmittedName": submittedName,
			"OfficialName":  officialName,
			"Website":       website,
			"TechBlogURL":   techBlogURL,
			"ATSURL":        atsURL,
			"ATSProvider":   atsProvider,
		}
		if err := s.render(w, r, "company_confirm.html", data); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
		}
		return
	}

	http.Redirect(w, r, "/companies/"+strconv.FormatInt(company.ID, 10), http.StatusSeeOther)
}

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

	latestDossier, err := s.dossiers.GetLatestByCompanyID(r.Context(), id)
	hasDossier := err == nil
	if err != nil && !errors.Is(err, dossiers.ErrDossierNotFound) {
		log.Printf("get dossier: %v", err)
		http.Error(w, "could not load company dossier", http.StatusInternalServerError)
		return
	}

	data := map[string]any{
		"Title":          company.OfficialName,
		"ActiveNav":      "companies",
		"Company":        company,
		"HasWebsite":     company.Website != "",
		"HasTechBlogURL": company.TechBlogURL != "",
		"HasATSURL":      company.ATSURL != "",
		"HasATSProvider": company.ATSProvider != "",
		"HasDossier":     hasDossier,
		"Dossier":        latestDossier,
		"HasCareersURL":  latestDossier.CareersURL != "",
		"HasLanguages":   len(latestDossier.MajorTechStacks.Languages) > 0,
		"HasFrontend":    len(latestDossier.MajorTechStacks.Frontend) > 0,
		"HasBackend":     len(latestDossier.MajorTechStacks.Backend) > 0,
		"HasInfra":       len(latestDossier.MajorTechStacks.Infrastructure) > 0,
		"HasData":        len(latestDossier.MajorTechStacks.Data) > 0,
		"HasTooling":     len(latestDossier.MajorTechStacks.Tooling) > 0,
	}
	if err := s.render(w, r, "company_show.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

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
		"Title":         "Edit company",
		"ActiveNav":     "companies",
		"Company":       company,
		"OfficialName":  company.OfficialName,
		"Website":       company.Website,
		"TechBlogURL":   company.TechBlogURL,
		"ATSURL":        company.ATSURL,
		"ATSProvider":   company.ATSProvider,
		"SubmittedName": company.SubmittedName,
	}
	if err := s.render(w, r, "company_edit.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

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
		"Title":         "Edit company",
		"ActiveNav":     "companies",
		"Error":         err.Error(),
		"Company":       existing,
		"OfficialName":  officialName,
		"Website":       website,
		"TechBlogURL":   techBlogURL,
		"ATSURL":        atsURL,
		"ATSProvider":   atsProvider,
		"SubmittedName": existing.SubmittedName,
	}
	if err := s.render(w, r, "company_edit.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

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

func (s *Server) render(w http.ResponseWriter, r *http.Request, page string, data map[string]any) error {
	if data == nil {
		data = map[string]any{}
	}

	if _, ok := data["CompaniesCount"]; !ok && s != nil && s.companies != nil {
		companiesList, err := s.companies.List(r.Context())
		if err != nil {
			log.Printf("list companies for layout: %v", err)
			data["CompaniesCount"] = 0
		} else {
			data["CompaniesCount"] = len(companiesList)
		}
	}

	if _, ok := data["PeopleCount"]; !ok && s != nil && s.people != nil {
		peopleList, err := s.people.List(r.Context())
		if err != nil {
			log.Printf("list people for layout: %v", err)
			data["PeopleCount"] = 0
		} else {
			data["PeopleCount"] = len(peopleList)
		}
	}

	tmpl, err := parseTemplates("base.html", page)
	if err != nil {
		log.Printf("parse templates: %v", err)
		return err
	}
	return tmpl.ExecuteTemplate(w, page, data)
}

func logging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Printf("%s %s", r.Method, r.URL.Path)
		next.ServeHTTP(w, r)
	})
}
