package companies

import (
	"context"
	"database/sql"
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

func (r *SQLRepository) Create(ctx context.Context, input CreateCompanyInput) (Company, error) {
	if r == nil || r.db == nil {
		return Company{}, errors.New("database is not configured")
	}

	now := time.Now().UTC()
	result, err := r.db.ExecContext(ctx, `
		INSERT INTO companies (
			submitted_name,
			official_name,
			website,
			ats_url,
			ats_provider,
			created_at,
			updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?)
	`,
		input.SubmittedName,
		input.OfficialName,
		input.Website,
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

func (r *SQLRepository) GetByID(ctx context.Context, id int64) (Company, error) {
	if r == nil || r.db == nil {
		return Company{}, errors.New("database is not configured")
	}

	row := r.db.QueryRowContext(ctx, `
		SELECT
			id,
			submitted_name,
			official_name,
			website,
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
		&company.SubmittedName,
		&company.OfficialName,
		&company.Website,
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

func (r *SQLRepository) List(ctx context.Context) ([]Company, error) {
	if r == nil || r.db == nil {
		return nil, errors.New("database is not configured")
	}

	rows, err := r.db.QueryContext(ctx, `
		SELECT
			id,
			submitted_name,
			official_name,
			website,
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
			&company.SubmittedName,
			&company.OfficialName,
			&company.Website,
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
