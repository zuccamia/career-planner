package http

// Builds the dashboard view shown on the home page.

import (
	"errors"
	"log"
	"net/http"

	"github.com/ngochoang/career-planner/internal/dossiers"
)

// home renders top-level dashboard metrics and recently updated companies.
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
	if len(recentCompanies) > 3 {
		recentCompanies = recentCompanies[:3]
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
		"CompaniesCount":          len(companiesList),
		"RecentCompanies":         recentCompanies,
		"HasRecentCompanies":      len(recentCompanies) > 0,
	}
	if err := s.render(w, r, "index.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}
