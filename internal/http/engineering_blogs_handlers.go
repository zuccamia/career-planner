package http

// Serves engineering blog note listing and CRUD pages.

import (
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/ngochoang/career-planner/internal/companies"
	"github.com/ngochoang/career-planner/internal/engineering_blogs"
)

// engineeringBlogsIndex renders all engineering blog notes, optionally filtered by company.
func (s *Server) engineeringBlogsIndex(w http.ResponseWriter, r *http.Request) {
	companyCounts, err := s.engineeringBlogs.ListCompanyCounts(r.Context())
	if err != nil {
		log.Printf("list engineering blog company counts: %v", err)
		http.Error(w, "could not load engineering blog notes", http.StatusInternalServerError)
		return
	}
	selectedCompanyID, _ := strconv.ParseInt(strings.TrimSpace(r.URL.Query().Get("company_id")), 10, 64)
	var notes []engineering_blogs.Note
	if selectedCompanyID > 0 {
		notes, err = s.engineeringBlogs.ListByCompanyID(r.Context(), selectedCompanyID)
	} else {
		notes, err = s.engineeringBlogs.List(r.Context())
	}
	if err != nil {
		log.Printf("list engineering blog notes: %v", err)
		http.Error(w, "could not load engineering blog notes", http.StatusInternalServerError)
		return
	}
	data := map[string]any{
		"Title":               "Engineering blogs",
		"ActiveNav":           "engineering-blogs",
		"EngineeringBlogs":    notes,
		"CompanyCounts":       companyCounts,
		"HasEngineeringBlogs": len(notes) > 0,
		"SelectedCompanyID":   selectedCompanyID,
	}
	if err := s.render(w, r, "engineering_blogs_index.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// companyEngineeringBlogs renders the engineering blog notes associated with one company.
func (s *Server) companyEngineeringBlogs(w http.ResponseWriter, r *http.Request) {
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
		log.Printf("get company for engineering blogs: %v", err)
		http.Error(w, "could not load company", http.StatusInternalServerError)
		return
	}
	notes, err := s.engineeringBlogs.ListByCompanyID(r.Context(), id)
	if err != nil {
		log.Printf("list company engineering blog notes: %v", err)
		http.Error(w, "could not load engineering blog notes", http.StatusInternalServerError)
		return
	}
	data := map[string]any{
		"Title":                company.OfficialName + " engineering blogs",
		"ActiveNav":            "engineering-blogs",
		"Company":              company,
		"EngineeringBlogs":     notes,
		"HasEngineeringBlogs":  len(notes) > 0,
		"EngineeringBlogCount": len(notes),
	}
	if err := s.render(w, r, "company_engineering_blogs.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// companyCreateEngineeringBlog saves a new engineering blog note for the selected company.
func (s *Server) companyCreateEngineeringBlog(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		http.NotFound(w, r)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "invalid form", http.StatusBadRequest)
		return
	}

	if _, companyErr := s.companies.GetByID(r.Context(), id); companyErr != nil {
		if errors.Is(companyErr, companies.ErrCompanyNotFound) {
			http.NotFound(w, r)
			return
		}
		log.Printf("get company before creating engineering blog note: %v", companyErr)
		http.Error(w, "could not load company", http.StatusInternalServerError)
		return
	}

	_, err = s.engineeringBlogs.Create(r.Context(), engineering_blogs.CreateInput{
		CompanyID: id,
		URL:       r.FormValue("url"),
		Notes:     r.FormValue("notes"),
	})
	if err == nil {
		http.Redirect(w, r, "/companies/"+strconv.FormatInt(id, 10)+"/engineering-blogs", http.StatusSeeOther)
		return
	}

	company, companyErr := s.companies.GetByID(r.Context(), id)
	if companyErr != nil {
		if errors.Is(companyErr, companies.ErrCompanyNotFound) {
			http.NotFound(w, r)
			return
		}
		log.Printf("get company for engineering note error state: %v", companyErr)
		http.Error(w, "could not load company", http.StatusInternalServerError)
		return
	}
	notes, listErr := s.engineeringBlogs.ListByCompanyID(r.Context(), id)
	if listErr != nil {
		log.Printf("list engineering blog notes for error state: %v", listErr)
		http.Error(w, "could not load engineering blog notes", http.StatusInternalServerError)
		return
	}
	data := map[string]any{
		"Title":                company.OfficialName + " engineering blogs",
		"ActiveNav":            "engineering-blogs",
		"Company":              company,
		"EngineeringBlogs":     notes,
		"HasEngineeringBlogs":  len(notes) > 0,
		"EngineeringBlogCount": len(notes),
		"EngineeringBlogError": err.Error(),
		"EngineeringBlogURL":   strings.TrimSpace(r.FormValue("url")),
		"EngineeringBlogNotes": strings.TrimSpace(r.FormValue("notes")),
	}
	if err := s.render(w, r, "company_engineering_blogs.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// engineeringBlogEditForm renders the edit form for an existing engineering note.
func (s *Server) engineeringBlogEditForm(w http.ResponseWriter, r *http.Request) {
	noteID, err := strconv.ParseInt(r.PathValue("noteID"), 10, 64)
	if err != nil || noteID <= 0 {
		http.NotFound(w, r)
		return
	}

	note, err := s.engineeringBlogs.GetByID(r.Context(), noteID)
	if err != nil {
		if errors.Is(err, engineering_blogs.ErrNoteNotFound) {
			http.NotFound(w, r)
			return
		}
		log.Printf("get engineering blog note for edit: %v", err)
		http.Error(w, "could not load engineering blog note", http.StatusInternalServerError)
		return
	}

	companiesList, err := s.companies.List(r.Context())
	if err != nil {
		log.Printf("list companies for engineering blog edit: %v", err)
		http.Error(w, "could not load engineering blog edit form", http.StatusInternalServerError)
		return
	}

	data := map[string]any{
		"Title":                "Edit engineering blog note",
		"ActiveNav":            "engineering-blogs",
		"Company":              companies.Company{ID: note.CompanyID, OfficialName: note.CompanyName},
		"Note":                 note,
		"Companies":            companiesList,
		"HasCompanies":         len(companiesList) > 0,
		"EngineeringBlogURL":   note.URL,
		"EngineeringBlogNotes": note.Notes,
	}
	if err := s.render(w, r, "engineering_blog_edit.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// engineeringBlogEditSubmit updates an engineering note from form input.
func (s *Server) engineeringBlogEditSubmit(w http.ResponseWriter, r *http.Request) {
	noteID, err := strconv.ParseInt(r.PathValue("noteID"), 10, 64)
	if err != nil || noteID <= 0 {
		http.NotFound(w, r)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "invalid form", http.StatusBadRequest)
		return
	}

	companyID, err := strconv.ParseInt(strings.TrimSpace(r.FormValue("company_id")), 10, 64)
	if err != nil {
		companyID = 0
	}

	note, err := s.engineeringBlogs.Update(r.Context(), engineering_blogs.UpdateInput{
		ID:        noteID,
		CompanyID: companyID,
		URL:       r.FormValue("url"),
		Notes:     r.FormValue("notes"),
	})
	if err == nil {
		http.Redirect(w, r, "/companies/"+strconv.FormatInt(note.CompanyID, 10)+"/engineering-blogs", http.StatusSeeOther)
		return
	}
	if errors.Is(err, engineering_blogs.ErrNoteNotFound) {
		http.NotFound(w, r)
		return
	}

	existing, getErr := s.engineeringBlogs.GetByID(r.Context(), noteID)
	if getErr != nil {
		if errors.Is(getErr, engineering_blogs.ErrNoteNotFound) {
			http.NotFound(w, r)
			return
		}
		log.Printf("get engineering blog note for edit error state: %v", getErr)
		http.Error(w, "could not load engineering blog note", http.StatusInternalServerError)
		return
	}
	companiesList, listErr := s.companies.List(r.Context())
	if listErr != nil {
		log.Printf("list companies for engineering blog edit error state: %v", listErr)
		http.Error(w, "could not load engineering blog edit form", http.StatusInternalServerError)
		return
	}
	data := map[string]any{
		"Title":                "Edit engineering blog note",
		"ActiveNav":            "engineering-blogs",
		"Company":              companies.Company{ID: existing.CompanyID, OfficialName: existing.CompanyName},
		"Note":                 existing,
		"Companies":            companiesList,
		"HasCompanies":         len(companiesList) > 0,
		"EngineeringBlogError": err.Error(),
		"EngineeringBlogURL":   strings.TrimSpace(r.FormValue("url")),
		"EngineeringBlogNotes": strings.TrimSpace(r.FormValue("notes")),
	}
	if err := s.render(w, r, "engineering_blog_edit.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// engineeringBlogDelete removes an engineering note and redirects to its company page.
func (s *Server) engineeringBlogDelete(w http.ResponseWriter, r *http.Request) {
	noteID, err := strconv.ParseInt(r.PathValue("noteID"), 10, 64)
	if err != nil || noteID <= 0 {
		http.NotFound(w, r)
		return
	}

	note, err := s.engineeringBlogs.GetByID(r.Context(), noteID)
	if err != nil {
		if errors.Is(err, engineering_blogs.ErrNoteNotFound) {
			http.NotFound(w, r)
			return
		}
		log.Printf("get engineering blog note for delete: %v", err)
		http.Error(w, "could not load engineering blog note", http.StatusInternalServerError)
		return
	}

	if err := s.engineeringBlogs.Delete(r.Context(), noteID); err != nil {
		if errors.Is(err, engineering_blogs.ErrNoteNotFound) {
			http.NotFound(w, r)
			return
		}
		log.Printf("delete engineering blog note: %v", err)
		http.Error(w, "could not delete engineering blog note", http.StatusInternalServerError)
		return
	}

	http.Redirect(w, r, "/companies/"+strconv.FormatInt(note.CompanyID, 10)+"/engineering-blogs", http.StatusSeeOther)
}
