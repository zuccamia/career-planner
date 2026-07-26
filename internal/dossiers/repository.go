package dossiers

// Stores dossiers and decodes structured JSON fields.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// SQLRepository stores dossier records in the application database.
type SQLRepository struct {
	db *sql.DB
}

// NewSQLRepository creates a dossier repository backed by the provided database handle.
func NewSQLRepository(db *sql.DB) *SQLRepository {
	if db == nil {
		panic("dossiers database is required")
	}
	return &SQLRepository{db: db}
}

// Create stores a completed dossier, overwriting any existing dossier for the company.
func (r *SQLRepository) Create(ctx context.Context, dossier Dossier) (Dossier, error) {
	targetCustomersJSON, err := json.Marshal(dossier.TargetCustomers)
	if err != nil {
		return Dossier{}, fmt.Errorf("marshal target customers: %w", err)
	}
	productAreasJSON, err := json.Marshal(dossier.ProductAreas)
	if err != nil {
		return Dossier{}, fmt.Errorf("marshal product areas: %w", err)
	}
	businessModelCluesJSON, err := json.Marshal(dossier.BusinessModelClues)
	if err != nil {
		return Dossier{}, fmt.Errorf("marshal business model clues: %w", err)
	}
	majorTechStacksJSON, err := json.Marshal(dossier.MajorTechStacks)
	if err != nil {
		return Dossier{}, fmt.Errorf("marshal major tech stacks: %w", err)
	}
	recentProductLaunchesJSON, err := json.Marshal(dossier.RecentProductLaunches)
	if err != nil {
		return Dossier{}, fmt.Errorf("marshal recent product launches: %w", err)
	}
	companyCultureNotesJSON, err := json.Marshal(dossier.CompanyCultureNotes)
	if err != nil {
		return Dossier{}, fmt.Errorf("marshal company culture notes: %w", err)
	}

	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := r.db.ExecContext(ctx, `
		UPDATE dossiers
		SET status = ?, careers_url = ?, company_summary = ?, what_the_company_does = ?, target_customers_json = ?, product_areas_json = ?, business_model_clues_json = ?, recent_product_launches_json = ?, company_culture_notes_json = ?, has_internships = ?, internship_seasons_json = ?, internship_summary = ?, major_tech_stacks_json = ?, updated_at = ?
		WHERE company_id = ?
	`,
		dossier.Status,
		dossier.CareersURL,
		dossier.CompanySummary,
		dossier.WhatTheCompanyDoes,
		string(targetCustomersJSON),
		string(productAreasJSON),
		string(businessModelCluesJSON),
		string(recentProductLaunchesJSON),
		string(companyCultureNotesJSON),
		dossier.HasInternships,
		marshalJSON(dossier.InternshipSeasons),
		dossier.InternshipSummary,
		string(majorTechStacksJSON),
		now,
		dossier.CompanyID,
	)
	if err != nil {
		return Dossier{}, fmt.Errorf("update dossier: %w", err)
	}

	affected, err := result.RowsAffected()
	if err != nil {
		return Dossier{}, fmt.Errorf("fetch updated dossier rows affected: %w", err)
	}
	if affected == 0 {
		result, err = r.db.ExecContext(ctx, `
			INSERT INTO dossiers (
				company_id,
				status,
				careers_url,
				company_summary,
				what_the_company_does,
				target_customers_json,
				product_areas_json,
				business_model_clues_json,
				recent_product_launches_json,
				company_culture_notes_json,
				has_internships,
				internship_seasons_json,
				internship_summary,
				major_tech_stacks_json,
				created_at,
				updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`,
			dossier.CompanyID,
			dossier.Status,
			dossier.CareersURL,
			dossier.CompanySummary,
			dossier.WhatTheCompanyDoes,
			string(targetCustomersJSON),
			string(productAreasJSON),
			string(businessModelCluesJSON),
			string(recentProductLaunchesJSON),
			string(companyCultureNotesJSON),
			dossier.HasInternships,
			marshalJSON(dossier.InternshipSeasons),
			dossier.InternshipSummary,
			string(majorTechStacksJSON),
			now,
			now,
		)
		if err != nil {
			return Dossier{}, fmt.Errorf("insert dossier: %w", err)
		}

		id, err := result.LastInsertId()
		if err != nil {
			return Dossier{}, fmt.Errorf("fetch inserted dossier id: %w", err)
		}

		return r.GetByID(ctx, id)
	}

	return r.GetLatestByCompanyID(ctx, dossier.CompanyID)
}

// GetLatestByCompanyID returns the most recently created dossier for a company.
func (r *SQLRepository) GetLatestByCompanyID(ctx context.Context, companyID int64) (Dossier, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT
			id,
			company_id,
			status,
			careers_url,
			company_summary,
			what_the_company_does,
			target_customers_json,
			product_areas_json,
			business_model_clues_json,
			recent_product_launches_json,
			company_culture_notes_json,
			has_internships,
			internship_seasons_json,
			internship_summary,
			major_tech_stacks_json,
			created_at,
			updated_at
		FROM dossiers
		WHERE company_id = ?
		ORDER BY created_at DESC, id DESC
		LIMIT 1
	`, companyID)

	return scanDossier(row)
}

// GetByID fetches a dossier by primary key.
func (r *SQLRepository) GetByID(ctx context.Context, id int64) (Dossier, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT
			id,
			company_id,
			status,
			careers_url,
			company_summary,
			what_the_company_does,
			target_customers_json,
			product_areas_json,
			business_model_clues_json,
			recent_product_launches_json,
			company_culture_notes_json,
			has_internships,
			internship_seasons_json,
			internship_summary,
			major_tech_stacks_json,
			created_at,
			updated_at
		FROM dossiers
		WHERE id = ?
	`, id)

	return scanDossier(row)
}

// scanner abstracts sql.Row and sql.Rows scanning for shared dossier decoding.
type scanner interface {
	Scan(dest ...any) error
}

// scanDossier decodes one dossier row, including its JSON-encoded fields.
func scanDossier(row scanner) (Dossier, error) {
	var dossier Dossier
	var targetCustomersJSON string
	var productAreasJSON string
	var businessModelCluesJSON string
	var recentProductLaunchesJSON string
	var companyCultureNotesJSON string
	var internshipSeasonsJSON string
	var internshipSummary string
	var majorTechStacksJSON string
	var createdAt string
	var updatedAt string

	if err := row.Scan(
		&dossier.ID,
		&dossier.CompanyID,
		&dossier.Status,
		&dossier.CareersURL,
		&dossier.CompanySummary,
		&dossier.WhatTheCompanyDoes,
		&targetCustomersJSON,
		&productAreasJSON,
		&businessModelCluesJSON,
		&recentProductLaunchesJSON,
		&companyCultureNotesJSON,
		&dossier.HasInternships,
		&internshipSeasonsJSON,
		&internshipSummary,
		&majorTechStacksJSON,
		&createdAt,
		&updatedAt,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Dossier{}, ErrDossierNotFound
		}
		return Dossier{}, fmt.Errorf("query dossier: %w", err)
	}

	if err := json.Unmarshal([]byte(targetCustomersJSON), &dossier.TargetCustomers); err != nil {
		return Dossier{}, fmt.Errorf("decode dossier target_customers_json: %w", err)
	}
	if err := json.Unmarshal([]byte(productAreasJSON), &dossier.ProductAreas); err != nil {
		return Dossier{}, fmt.Errorf("decode dossier product_areas_json: %w", err)
	}
	if err := json.Unmarshal([]byte(businessModelCluesJSON), &dossier.BusinessModelClues); err != nil {
		return Dossier{}, fmt.Errorf("decode dossier business_model_clues_json: %w", err)
	}
	if err := json.Unmarshal([]byte(recentProductLaunchesJSON), &dossier.RecentProductLaunches); err != nil {
		return Dossier{}, fmt.Errorf("decode dossier recent_product_launches_json: %w", err)
	}
	if err := json.Unmarshal([]byte(companyCultureNotesJSON), &dossier.CompanyCultureNotes); err != nil {
		return Dossier{}, fmt.Errorf("decode dossier company_culture_notes_json: %w", err)
	}
	if err := json.Unmarshal([]byte(internshipSeasonsJSON), &dossier.InternshipSeasons); err != nil {
		return Dossier{}, fmt.Errorf("decode dossier internship_seasons_json: %w", err)
	}
	if err := json.Unmarshal([]byte(majorTechStacksJSON), &dossier.MajorTechStacks); err != nil {
		return Dossier{}, fmt.Errorf("decode dossier major_tech_stacks_json: %w", err)
	}
	dossier.InternshipSummary = internshipSummary

	parsedCreatedAt, err := time.Parse(time.RFC3339Nano, createdAt)
	if err != nil {
		return Dossier{}, fmt.Errorf("parse dossier created_at: %w", err)
	}
	parsedUpdatedAt, err := time.Parse(time.RFC3339Nano, updatedAt)
	if err != nil {
		return Dossier{}, fmt.Errorf("parse dossier updated_at: %w", err)
	}
	dossier.CreatedAt = parsedCreatedAt
	dossier.UpdatedAt = parsedUpdatedAt

	return dossier, nil
}
