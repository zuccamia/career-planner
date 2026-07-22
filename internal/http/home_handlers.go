package http

// Builds the dashboard view shown on the home page.

import (
	"context"
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
		"ApplicationsCount":       countApplicationsByStatus(r.Context(), s.applications),
		"InterviewsCount":         0,
		"OffersCount":             countApplicationsByStatus(r.Context(), s.applications, "offer"),
		"RejectionsCount":         countApplicationsByStatus(r.Context(), s.applications, "rejected"),
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

func countApplicationsByStatus(ctx context.Context, service interface {
	Count(context.Context) (int, error)
	CountByStatus(context.Context, string) (int, error)
}, status ...string) int {
	if service == nil {
		return 0
	}
	var (
		count int
		err   error
	)
	if len(status) == 0 {
		count, err = service.Count(ctx)
	} else {
		count, err = service.CountByStatus(ctx, status[0])
	}
	if err != nil {
		log.Printf("count applications for dashboard: %v", err)
		return 0
	}
	return count
}
