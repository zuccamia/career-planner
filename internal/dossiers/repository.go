package dossiers

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

type SQLRepository struct {
	db *sql.DB
}

func NewSQLRepository(db *sql.DB) *SQLRepository {
	return &SQLRepository{db: db}
}

func (r *SQLRepository) Create(ctx context.Context, dossier Dossier) (Dossier, error) {
	if r == nil || r.db == nil {
		return Dossier{}, errors.New("database is not configured")
	}

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

	now := time.Now().UTC()
	result, err := r.db.ExecContext(ctx, `
		INSERT INTO dossiers (
			company_id,
			status,
			careers_url,
			tech_blog_url,
			company_summary,
			what_the_company_does,
			target_customers_json,
			product_areas_json,
			business_model_clues_json,
			major_tech_stacks_json,
			created_at,
			updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`,
		dossier.CompanyID,
		dossier.Status,
		dossier.CareersURL,
		dossier.TechBlogURL,
		dossier.CompanySummary,
		dossier.WhatTheCompanyDoes,
		string(targetCustomersJSON),
		string(productAreasJSON),
		string(businessModelCluesJSON),
		string(majorTechStacksJSON),
		now.Format(time.RFC3339Nano),
		now.Format(time.RFC3339Nano),
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

func (r *SQLRepository) GetLatestByCompanyID(ctx context.Context, companyID int64) (Dossier, error) {
	if r == nil || r.db == nil {
		return Dossier{}, errors.New("database is not configured")
	}

	row := r.db.QueryRowContext(ctx, `
		SELECT
			id,
			company_id,
			status,
			careers_url,
			tech_blog_url,
			company_summary,
			what_the_company_does,
			target_customers_json,
			product_areas_json,
			business_model_clues_json,
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

func (r *SQLRepository) GetByID(ctx context.Context, id int64) (Dossier, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT
			id,
			company_id,
			status,
			careers_url,
			tech_blog_url,
			company_summary,
			what_the_company_does,
			target_customers_json,
			product_areas_json,
			business_model_clues_json,
			major_tech_stacks_json,
			created_at,
			updated_at
		FROM dossiers
		WHERE id = ?
	`, id)

	return scanDossier(row)
}

type scanner interface {
	Scan(dest ...any) error
}

func scanDossier(row scanner) (Dossier, error) {
	var dossier Dossier
	var targetCustomersJSON string
	var productAreasJSON string
	var businessModelCluesJSON string
	var majorTechStacksJSON string
	var createdAt string
	var updatedAt string

	if err := row.Scan(
		&dossier.ID,
		&dossier.CompanyID,
		&dossier.Status,
		&dossier.CareersURL,
		&dossier.TechBlogURL,
		&dossier.CompanySummary,
		&dossier.WhatTheCompanyDoes,
		&targetCustomersJSON,
		&productAreasJSON,
		&businessModelCluesJSON,
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
	if err := json.Unmarshal([]byte(majorTechStacksJSON), &dossier.MajorTechStacks); err != nil {
		return Dossier{}, fmt.Errorf("decode dossier major_tech_stacks_json: %w", err)
	}

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
