package companies

// Persists companies and cleans up dependent data.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// SQLRepository stores company records in the application database.
type SQLRepository struct {
	db *sql.DB
}

// NewSQLRepository creates a company repository backed by the provided database handle.
func NewSQLRepository(db *sql.DB) *SQLRepository {
	if db == nil {
		panic("companies database is required")
	}
	return &SQLRepository{db: db}
}

// Count returns the total number of saved companies.
func (r *SQLRepository) Count(ctx context.Context) (int, error) {
	row := r.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM companies`)
	var count int
	if err := row.Scan(&count); err != nil {
		return 0, fmt.Errorf("count companies: %w", err)
	}
	return count, nil
}

// Create inserts a new company row and returns the stored record.
func (r *SQLRepository) Create(ctx context.Context, input CreateCompanyInput) (Company, error) {
	now := time.Now().UTC()
	result, err := r.db.ExecContext(ctx, `
		INSERT INTO companies (
			official_name,
			website,
			tech_blog_url,
			ats_url,
			ats_provider,
			created_at,
			updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?)
	`,
		input.OfficialName,
		input.Website,
		input.TechBlogURL,
		input.ATSURL,
		input.ATSProvider,
		now.Format(time.RFC3339Nano),
		now.Format(time.RFC3339Nano),
	)
	if err != nil {
		return Company{}, fmt.Errorf("insert company: %w", err)
	}

	id, err := result.LastInsertId()
	if err != nil {
		return Company{}, fmt.Errorf("fetch inserted company id: %w", err)
	}

	return r.GetByID(ctx, id)
}

// Delete removes a company and the dependent data that should not outlive it.
func (r *SQLRepository) Delete(ctx context.Context, id int64) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin delete company transaction: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, `DELETE FROM dossiers WHERE company_id = ?`, id); err != nil {
		return fmt.Errorf("delete company dossiers: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM engineering_blog_notes WHERE company_id = ?`, id); err != nil {
		return fmt.Errorf("delete company engineering blog notes: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE people SET company_id = NULL, updated_at = ? WHERE company_id = ?`, time.Now().UTC().Format(time.RFC3339Nano), id); err != nil {
		return fmt.Errorf("clear company from people: %w", err)
	}

	result, err := tx.ExecContext(ctx, `DELETE FROM companies WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete company: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("fetch deleted company rows affected: %w", err)
	}
	if affected == 0 {
		return ErrCompanyNotFound
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit delete company transaction: %w", err)
	}

	return nil
}

// Update writes editable fields for an existing company and returns the fresh record.
func (r *SQLRepository) Update(ctx context.Context, input UpdateCompanyInput) (Company, error) {
	result, err := r.db.ExecContext(ctx, `
		UPDATE companies
		SET official_name = ?, website = ?, tech_blog_url = ?, ats_url = ?, ats_provider = ?, updated_at = ?
		WHERE id = ?
	`,
		input.OfficialName,
		input.Website,
		input.TechBlogURL,
		input.ATSURL,
		input.ATSProvider,
		time.Now().UTC().Format(time.RFC3339Nano),
		input.ID,
	)
	if err != nil {
		return Company{}, fmt.Errorf("update company: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return Company{}, fmt.Errorf("fetch updated company rows affected: %w", err)
	}
	if affected == 0 {
		return Company{}, ErrCompanyNotFound
	}

	return r.GetByID(ctx, input.ID)
}

// GetByID fetches one company by primary key.
func (r *SQLRepository) GetByID(ctx context.Context, id int64) (Company, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT
			id,
			official_name,
			website,
			tech_blog_url,
			ats_url,
			ats_provider,
			created_at,
			updated_at
		FROM companies
		WHERE id = ?
	`, id)

	var company Company
	var createdAt string
	var updatedAt string
	if err := row.Scan(
		&company.ID,
		&company.OfficialName,
		&company.Website,
		&company.TechBlogURL,
		&company.ATSURL,
		&company.ATSProvider,
		&createdAt,
		&updatedAt,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Company{}, ErrCompanyNotFound
		}
		return Company{}, fmt.Errorf("query company: %w", err)
	}

	parsedCreatedAt, err := time.Parse(time.RFC3339Nano, createdAt)
	if err != nil {
		return Company{}, fmt.Errorf("parse company created_at: %w", err)
	}
	parsedUpdatedAt, err := time.Parse(time.RFC3339Nano, updatedAt)
	if err != nil {
		return Company{}, fmt.Errorf("parse company updated_at: %w", err)
	}
	company.CreatedAt = parsedCreatedAt
	company.UpdatedAt = parsedUpdatedAt

	return company, nil
}

// List returns companies ordered by most recently updated first.
func (r *SQLRepository) List(ctx context.Context) ([]Company, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT
			id,
			official_name,
			website,
			tech_blog_url,
			ats_url,
			ats_provider,
			created_at,
			updated_at
		FROM companies
		ORDER BY updated_at DESC, id DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("list companies: %w", err)
	}
	defer rows.Close()

	companies := make([]Company, 0)
	for rows.Next() {
		var company Company
		var createdAt string
		var updatedAt string
		if err := rows.Scan(
			&company.ID,
			&company.OfficialName,
			&company.Website,
			&company.TechBlogURL,
			&company.ATSURL,
			&company.ATSProvider,
			&createdAt,
			&updatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan company list row: %w", err)
		}

		parsedCreatedAt, err := time.Parse(time.RFC3339Nano, createdAt)
		if err != nil {
			return nil, fmt.Errorf("parse company list created_at: %w", err)
		}
		parsedUpdatedAt, err := time.Parse(time.RFC3339Nano, updatedAt)
		if err != nil {
			return nil, fmt.Errorf("parse company list updated_at: %w", err)
		}
		company.CreatedAt = parsedCreatedAt
		company.UpdatedAt = parsedUpdatedAt

		companies = append(companies, company)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate companies: %w", err)
	}

	return companies, nil
}
