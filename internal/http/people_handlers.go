package http

// Serves pages for listing, creating, editing, and deleting people records.

import (
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/ngochoang/career-planner/internal/people"
)

// peopleIndex renders the list of saved people.
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

// personNewForm renders the add-person form with available company options.
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

// personEditForm renders the person edit form for an existing record.
func (s *Server) personEditForm(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		http.NotFound(w, r)
		return
	}

	person, err := s.people.GetByID(r.Context(), id)
	if err != nil {
		if errors.Is(err, people.ErrPersonNotFound) {
			http.NotFound(w, r)
			return
		}
		log.Printf("get person for edit: %v", err)
		http.Error(w, "could not load person", http.StatusInternalServerError)
		return
	}

	companiesList, err := s.companies.List(r.Context())
	if err != nil {
		log.Printf("list companies for person edit form: %v", err)
		http.Error(w, "could not load person form", http.StatusInternalServerError)
		return
	}

	data := map[string]any{
		"Title":             "Edit person",
		"ActiveNav":         "people",
		"Person":            person,
		"Companies":         companiesList,
		"HasCompanies":      len(companiesList) > 0,
		"FullName":          person.FullName,
		"PersonTitle":       person.Title,
		"SelectedCompanyID": person.CompanyID,
		"LinkedInURL":       person.LinkedInURL,
		"Notes":             person.Notes,
	}
	if err := s.render(w, r, "person_edit.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// personCreate saves a new person record from submitted form input.
func (s *Server) personCreate(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, "invalid form", http.StatusBadRequest)
		return
	}

	companyID, err := strconv.ParseInt(strings.TrimSpace(r.FormValue("company_id")), 10, 64)
	if err != nil {
		companyID = 0
	}

	_, err = s.people.Create(r.Context(), people.CreatePersonInput{
		FullName:    r.FormValue("full_name"),
		Title:       r.FormValue("title"),
		CompanyID:   companyID,
		LinkedInURL: r.FormValue("linkedin_url"),
		Notes:       r.FormValue("notes"),
	})
	if err == nil {
		http.Redirect(w, r, "/people", http.StatusSeeOther)
		return
	}

	companiesList, listErr := s.companies.List(r.Context())
	if listErr != nil {
		log.Printf("list companies for person error state: %v", listErr)
		http.Error(w, "could not load people form", http.StatusInternalServerError)
		return
	}

	data := map[string]any{
		"Title":        "Add person",
		"ActiveNav":    "people",
		"Companies":    companiesList,
		"HasCompanies": len(companiesList) > 0,
		"Error":        err.Error(),
		"FullName":     strings.TrimSpace(r.FormValue("full_name")),
		"TitleValue":   strings.TrimSpace(r.FormValue("title")),
		"CompanyID":    companyID,
		"LinkedInURL":  strings.TrimSpace(r.FormValue("linkedin_url")),
		"Notes":        strings.TrimSpace(r.FormValue("notes")),
	}
	if err := s.render(w, r, "person_new.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// personEditSubmit saves edits to an existing person record.
func (s *Server) personEditSubmit(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
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
	fullName := strings.TrimSpace(r.FormValue("full_name"))
	title := strings.TrimSpace(r.FormValue("title"))
	linkedInURL := strings.TrimSpace(r.FormValue("linkedin_url"))
	notes := strings.TrimSpace(r.FormValue("notes"))

	_, err = s.people.Update(r.Context(), people.UpdatePersonInput{
		ID:          id,
		FullName:    fullName,
		Title:       title,
		CompanyID:   companyID,
		LinkedInURL: linkedInURL,
		Notes:       notes,
	})
	if err == nil {
		http.Redirect(w, r, "/people", http.StatusSeeOther)
		return
	}
	if errors.Is(err, people.ErrPersonNotFound) {
		http.NotFound(w, r)
		return
	}

	existing, getErr := s.people.GetByID(r.Context(), id)
	if getErr != nil {
		log.Printf("get person for edit error state: %v", getErr)
		http.Error(w, "could not load person", http.StatusInternalServerError)
		return
	}
	companiesList, listErr := s.companies.List(r.Context())
	if listErr != nil {
		log.Printf("list companies for person edit error state: %v", listErr)
		http.Error(w, "could not load person form", http.StatusInternalServerError)
		return
	}

	data := map[string]any{
		"Title":             "Edit person",
		"ActiveNav":         "people",
		"Error":             err.Error(),
		"Person":            existing,
		"Companies":         companiesList,
		"HasCompanies":      len(companiesList) > 0,
		"FullName":          fullName,
		"PersonTitle":       title,
		"SelectedCompanyID": companyID,
		"LinkedInURL":       linkedInURL,
		"Notes":             notes,
	}
	if err := s.render(w, r, "person_edit.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// personDelete removes a person and redirects back to the people list.
func (s *Server) personDelete(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		http.NotFound(w, r)
		return
	}

	if err := s.people.Delete(r.Context(), id); err != nil {
		if errors.Is(err, people.ErrPersonNotFound) {
			http.NotFound(w, r)
			return
		}
		log.Printf("delete person: %v", err)
		http.Error(w, "could not delete person", http.StatusInternalServerError)
		return
	}

	http.Redirect(w, r, "/people", http.StatusSeeOther)
}
