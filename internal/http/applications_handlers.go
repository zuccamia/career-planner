package http

// Serves pages for listing, creating, and viewing job applications.

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/ngochoang/career-planner/internal/applications"
)

// applicationsIndex renders the list of saved applications.
func (s *Server) applicationsIndex(w http.ResponseWriter, r *http.Request) {
	applicationsList, err := s.applications.List(r.Context())
	if err != nil {
		log.Printf("list applications: %v", err)
		http.Error(w, "could not load applications", http.StatusInternalServerError)
		return
	}

	data := map[string]any{
		"Title":           "Applications",
		"ActiveNav":       "applications",
		"Applications":    applicationsList,
		"HasApplications": len(applicationsList) > 0,
	}
	if err := s.render(w, r, "applications_index.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// applicationNewForm renders the add-application form.
func (s *Server) applicationNewForm(w http.ResponseWriter, r *http.Request) {
	s.renderApplicationForm(w, r, map[string]any{
		"Title":     "Add application",
		"ActiveNav": "applications",
	})
}

// applicationCreate creates a new application and redirects to its detail page.
func (s *Server) applicationCreate(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, "invalid form", http.StatusBadRequest)
		return
	}
	companyID, _ := strconv.ParseInt(strings.TrimSpace(r.FormValue("company_id")), 10, 64)
	personID, _ := strconv.ParseInt(strings.TrimSpace(r.FormValue("person_id")), 10, 64)
	application, err := s.applications.Create(r.Context(), applications.CreateApplicationInput{
		CompanyID:         companyID,
		PersonID:          personID,
		RoleTitle:         r.FormValue("role_title"),
		JobPostingURL:     r.FormValue("job_posting_url"),
		JobDescriptionRaw: r.FormValue("job_description_raw"),
		Status:            r.FormValue("status"),
		Notes:             r.FormValue("notes"),
	})
	if err == nil {
		http.Redirect(w, r, "/applications/"+strconv.FormatInt(application.ID, 10), http.StatusSeeOther)
		return
	}

	s.renderApplicationForm(w, r, applicationFormData(applicationFormOptions{
		Title:             "Add application",
		Error:             err.Error(),
		SelectedCompanyID: companyID,
		SelectedPersonID:  personID,
		RoleTitle:         r.FormValue("role_title"),
		JobPostingURL:     r.FormValue("job_posting_url"),
		JobDescriptionRaw: r.FormValue("job_description_raw"),
		Status:            r.FormValue("status"),
		Notes:             r.FormValue("notes"),
	}))
}

// applicationEditForm renders the edit form for an existing application.
func (s *Server) applicationEditForm(w http.ResponseWriter, r *http.Request) {
	id, ok := applicationPathID(r)
	if !ok {
		http.NotFound(w, r)
		return
	}
	application, err := s.applications.GetByID(r.Context(), id)
	if err != nil {
		if errors.Is(err, applications.ErrApplicationNotFound) {
			http.NotFound(w, r)
			return
		}
		log.Printf("get application for edit: %v", err)
		http.Error(w, "could not load application", http.StatusInternalServerError)
		return
	}
	s.renderApplicationForm(w, r, applicationFormData(applicationFormOptions{
		Title:             "Edit application",
		FormTitle:         "Edit application",
		FormAction:        "/applications/" + strconv.FormatInt(application.ID, 10) + "/edit",
		SubmitLabel:       "Save changes",
		BackHref:          "/applications/" + strconv.FormatInt(application.ID, 10),
		BackLabel:         "← Back to application",
		SelectedCompanyID: application.CompanyID,
		SelectedPersonID:  application.PersonID,
		RoleTitle:         application.RoleTitle,
		JobPostingURL:     application.JobPostingURL,
		JobDescriptionRaw: application.JobDescriptionRaw,
		Status:            application.Status,
		Notes:             application.Notes,
	}))
}

// applicationEditSubmit saves edits to an existing application.
func (s *Server) applicationEditSubmit(w http.ResponseWriter, r *http.Request) {
	id, ok := applicationPathID(r)
	if !ok {
		http.NotFound(w, r)
		return
	}
	var err error
	if err := r.ParseForm(); err != nil {
		http.Error(w, "invalid form", http.StatusBadRequest)
		return
	}

	companyID, _ := strconv.ParseInt(strings.TrimSpace(r.FormValue("company_id")), 10, 64)
	personID, _ := strconv.ParseInt(strings.TrimSpace(r.FormValue("person_id")), 10, 64)
	existing, err := s.applications.GetByID(r.Context(), id)
	if err != nil {
		if errors.Is(err, applications.ErrApplicationNotFound) {
			http.NotFound(w, r)
			return
		}
		log.Printf("get application before update: %v", err)
		http.Error(w, "could not load application", http.StatusInternalServerError)
		return
	}
	application, err := s.applications.Update(r.Context(), applications.UpdateApplicationInput{
		ID:                          id,
		CompanyID:                   companyID,
		PersonID:                    personID,
		RoleTitle:                   r.FormValue("role_title"),
		JobPostingURL:               r.FormValue("job_posting_url"),
		JobDescriptionRaw:           r.FormValue("job_description_raw"),
		JobDescriptionExtractedJSON: existing.JobDescriptionExtractedJSON,
		Status:                      r.FormValue("status"),
		Notes:                       r.FormValue("notes"),
	})
	if err == nil {
		http.Redirect(w, r, "/applications/"+strconv.FormatInt(application.ID, 10), http.StatusSeeOther)
		return
	}
	if errors.Is(err, applications.ErrApplicationNotFound) {
		http.NotFound(w, r)
		return
	}

	s.renderApplicationForm(w, r, applicationFormData(applicationFormOptions{
		Title:             "Edit application",
		FormTitle:         "Edit application",
		FormAction:        "/applications/" + strconv.FormatInt(id, 10) + "/edit",
		SubmitLabel:       "Save changes",
		BackHref:          "/applications/" + strconv.FormatInt(id, 10),
		BackLabel:         "← Back to application",
		Error:             err.Error(),
		SelectedCompanyID: companyID,
		SelectedPersonID:  personID,
		RoleTitle:         r.FormValue("role_title"),
		JobPostingURL:     r.FormValue("job_posting_url"),
		JobDescriptionRaw: r.FormValue("job_description_raw"),
		Status:            r.FormValue("status"),
		Notes:             r.FormValue("notes"),
	}))
}

// applicationShow renders one application with its events and artifacts.
func (s *Server) applicationShow(w http.ResponseWriter, r *http.Request) {
	id, ok := applicationPathID(r)
	if !ok {
		http.NotFound(w, r)
		return
	}
	var err error

	application, err := s.applications.GetByID(r.Context(), id)
	if err != nil {
		if errors.Is(err, applications.ErrApplicationNotFound) {
			http.NotFound(w, r)
			return
		}
		log.Printf("get application: %v", err)
		http.Error(w, "could not load application", http.StatusInternalServerError)
		return
	}

	events, err := s.applications.ListEventsByApplicationID(r.Context(), id)
	if err != nil {
		log.Printf("list application events: %v", err)
		http.Error(w, "could not load application", http.StatusInternalServerError)
		return
	}
	artifacts, err := s.applications.ListArtifactsByApplicationID(r.Context(), id)
	if err != nil {
		log.Printf("list application artifacts: %v", err)
		http.Error(w, "could not load application", http.StatusInternalServerError)
		return
	}

	structured := applications.JobDescriptionStructured{}
	hasStructured := false
	structuredParseError := false
	if trimmed := strings.TrimSpace(application.JobDescriptionExtractedJSON); trimmed != "" && trimmed != "{}" {
		if err := json.Unmarshal([]byte(trimmed), &structured); err != nil {
			structuredParseError = true
			log.Printf("parse extracted job description for application %d: %v", application.ID, err)
		} else {
			hasStructured = true
		}
	}

	data := map[string]any{
		"Title":                 application.RoleTitle,
		"ActiveNav":             "applications",
		"Application":           application,
		"Structured":            structured,
		"RoleLevelLabel":        formatSlugLabel(structured.RoleLevel),
		"EmploymentTypeLabel":   formatSlugLabel(structured.EmploymentType),
		"SeasonLabel":           formatSlugLabel(structured.Season),
		"SalaryLabel":           formatSalaryLabel(structured.Salary.Currency, structured.Salary.Amount),
		"Events":                events,
		"Artifacts":             artifacts,
		"HasEvents":             len(events) > 0,
		"HasArtifacts":          len(artifacts) > 0,
		"HasJobPostingURL":      strings.TrimSpace(application.JobPostingURL) != "",
		"HasPerson":             application.PersonID > 0,
		"HasNotes":              strings.TrimSpace(application.Notes) != "",
		"HasJobDescriptionRaw":  strings.TrimSpace(application.JobDescriptionRaw) != "",
		"HasStructured":         hasStructured,
		"StructuredParseError":  structuredParseError,
		"HasSalary":             strings.TrimSpace(structured.Salary.Amount) != "",
		"HasLocations":          len(structured.Locations) > 0,
		"HasLocationNotes":      strings.TrimSpace(structured.LocationNotes) != "",
		"HasDeadline":           strings.TrimSpace(structured.ApplicationDeadline) != "",
		"HasSummary":            strings.TrimSpace(structured.Summary) != "",
		"HasMinQualifications":  len(structured.MinimumQualifications) > 0,
		"HasPrefQualifications": len(structured.PreferredQualifications) > 0,
		"HasResponsibilities":   len(structured.Responsibilities) > 0,
		"HasLanguages":          len(structured.Languages) > 0,
		"HasSkills":             len(structured.Skills) > 0,
		"HasDomains":            len(structured.Domains) > 0,
		"HasEducation":          len(structured.Requirements.Education) > 0,
		"HasMajors":             len(structured.Requirements.Majors) > 0,
		"HasAvailability":       len(structured.Requirements.Availability) > 0,
		"HasWorkAuthorization":  strings.TrimSpace(structured.Requirements.WorkAuthorization) != "",
	}
	if err := s.render(w, r, "application_show.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func formatSlugLabel(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	value = strings.ReplaceAll(value, "_", " ")
	parts := strings.Fields(strings.ToLower(value))
	for i, part := range parts {
		if len(part) == 0 {
			continue
		}
		parts[i] = strings.ToUpper(part[:1]) + part[1:]
	}
	return strings.Join(parts, " ")
}

func formatSalaryLabel(currency, amount string) string {
	currency = strings.TrimSpace(currency)
	amount = strings.TrimSpace(amount)
	if amount == "" {
		return ""
	}
	switch strings.ToUpper(currency) {
	case "USD":
		currency = "$"
	case "EUR":
		currency = "€"
	case "GBP":
		currency = "£"
	case "JPY":
		currency = "¥"
	}
	if currency == "" {
		return amount
	}
	return currency + amount
}

// applicationExtractJobDescription generates structured JSON for one application's raw job description.
func (s *Server) applicationExtractJobDescription(w http.ResponseWriter, r *http.Request) {
	id, ok := applicationPathID(r)
	if !ok {
		http.NotFound(w, r)
		return
	}
	var err error
	_, err = s.applications.ExtractJobDescription(r.Context(), id)
	if err != nil {
		if errors.Is(err, applications.ErrApplicationNotFound) {
			http.NotFound(w, r)
			return
		}
		log.Printf("extract job description for application %d: %v", id, err)
		http.Error(w, "could not extract job description", http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, "/applications/"+strconv.FormatInt(id, 10), http.StatusSeeOther)
}

// applicationDelete removes an application and redirects back to the applications list.
func (s *Server) applicationDelete(w http.ResponseWriter, r *http.Request) {
	id, ok := applicationPathID(r)
	if !ok {
		http.NotFound(w, r)
		return
	}

	if err := s.applications.Delete(r.Context(), id); err != nil {
		if errors.Is(err, applications.ErrApplicationNotFound) {
			http.NotFound(w, r)
			return
		}
		log.Printf("delete application: %v", err)
		http.Error(w, "could not delete application", http.StatusInternalServerError)
		return
	}

	http.Redirect(w, r, "/applications", http.StatusSeeOther)
}

func (s *Server) renderApplicationForm(w http.ResponseWriter, r *http.Request, data map[string]any) {
	companiesList, err := s.companies.List(r.Context())
	if err != nil {
		log.Printf("list companies for application form: %v", err)
		http.Error(w, "could not load application form", http.StatusInternalServerError)
		return
	}
	peopleList, err := s.people.List(r.Context())
	if err != nil {
		log.Printf("list people for application form: %v", err)
		http.Error(w, "could not load application form", http.StatusInternalServerError)
		return
	}
	if data == nil {
		data = map[string]any{}
	}
	if _, ok := data["FormTitle"]; !ok {
		data["FormTitle"] = "Add application"
	}
	if _, ok := data["FormAction"]; !ok {
		data["FormAction"] = "/applications"
	}
	if _, ok := data["SubmitLabel"]; !ok {
		data["SubmitLabel"] = "Save"
	}
	if _, ok := data["BackHref"]; !ok {
		data["BackHref"] = "/applications"
	}
	if _, ok := data["BackLabel"]; !ok {
		data["BackLabel"] = "← Back to applications"
	}
	data["Companies"] = companiesList
	data["People"] = peopleList
	data["HasCompanies"] = len(companiesList) > 0
	data["HasPeople"] = len(peopleList) > 0
	data["Statuses"] = applications.Statuses
	if _, ok := data["Status"]; !ok {
		data["Status"] = "wishlist"
	}
	if err := s.render(w, r, "application_new.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

type applicationFormOptions struct {
	Title             string
	FormTitle         string
	FormAction        string
	SubmitLabel       string
	BackHref          string
	BackLabel         string
	Error             string
	SelectedCompanyID int64
	SelectedPersonID  int64
	RoleTitle         string
	JobPostingURL     string
	JobDescriptionRaw string
	Status            string
	Notes             string
}

func applicationFormData(options applicationFormOptions) map[string]any {
	data := map[string]any{
		"Title":             options.Title,
		"FormTitle":         options.FormTitle,
		"FormAction":        options.FormAction,
		"SubmitLabel":       options.SubmitLabel,
		"BackHref":          options.BackHref,
		"BackLabel":         options.BackLabel,
		"ActiveNav":         "applications",
		"Error":             options.Error,
		"SelectedCompanyID": options.SelectedCompanyID,
		"SelectedPersonID":  options.SelectedPersonID,
		"RoleTitle":         strings.TrimSpace(options.RoleTitle),
		"JobPostingURL":     strings.TrimSpace(options.JobPostingURL),
		"JobDescriptionRaw": strings.TrimSpace(options.JobDescriptionRaw),
		"Status":            strings.TrimSpace(options.Status),
		"Notes":             strings.TrimSpace(options.Notes),
	}
	if data["FormTitle"] == "" {
		data["FormTitle"] = data["Title"]
	}
	if data["FormAction"] == "" {
		data["FormAction"] = "/applications"
	}
	if data["SubmitLabel"] == "" {
		data["SubmitLabel"] = "Save"
	}
	if data["BackHref"] == "" {
		data["BackHref"] = "/applications"
	}
	if data["BackLabel"] == "" {
		data["BackLabel"] = "← Back to applications"
	}
	return data
}

func applicationPathID(r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		return 0, false
	}
	return id, true
}
