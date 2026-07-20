package people

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

func (r *SQLRepository) Create(ctx context.Context, input CreatePersonInput) (Person, error) {
	if r == nil || r.db == nil {
		return Person{}, errors.New("database is not configured")
	}

	now := time.Now().UTC()
	result, err := r.db.ExecContext(ctx, `
		INSERT INTO people (
			full_name,
			title,
			company_id,
			linkedin_url,
			notes,
			created_at,
			updated_at
		) VALUES (?, ?, NULLIF(?, 0), ?, ?, ?, ?)
	`,
		input.FullName,
		input.Title,
		input.CompanyID,
		input.LinkedInURL,
		input.Notes,
		now.Format(time.RFC3339Nano),
		now.Format(time.RFC3339Nano),
	)
	if err != nil {
		return Person{}, fmt.Errorf("insert person: %w", err)
	}

	id, err := result.LastInsertId()
	if err != nil {
		return Person{}, fmt.Errorf("fetch inserted person id: %w", err)
	}

	people, err := r.List(ctx)
	if err != nil {
		return Person{}, err
	}
	for _, person := range people {
		if person.ID == id {
			return person, nil
		}
	}

	return Person{}, errors.New("created person could not be loaded")
}

func (r *SQLRepository) List(ctx context.Context) ([]Person, error) {
	if r == nil || r.db == nil {
		return nil, errors.New("database is not configured")
	}

	rows, err := r.db.QueryContext(ctx, `
		SELECT
			p.id,
			p.full_name,
			p.title,
			COALESCE(p.company_id, 0),
			COALESCE(c.official_name, ''),
			p.linkedin_url,
			p.notes,
			p.created_at,
			p.updated_at
		FROM people p
		LEFT JOIN companies c ON c.id = p.company_id
		ORDER BY p.updated_at DESC, p.id DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("list people: %w", err)
	}
	defer rows.Close()

	peopleList := make([]Person, 0)
	for rows.Next() {
		var person Person
		var createdAt string
		var updatedAt string
		if err := rows.Scan(
			&person.ID,
			&person.FullName,
			&person.Title,
			&person.CompanyID,
			&person.CompanyName,
			&person.LinkedInURL,
			&person.Notes,
			&createdAt,
			&updatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan people row: %w", err)
		}

		parsedCreatedAt, err := time.Parse(time.RFC3339Nano, createdAt)
		if err != nil {
			return nil, fmt.Errorf("parse person created_at: %w", err)
		}
		parsedUpdatedAt, err := time.Parse(time.RFC3339Nano, updatedAt)
		if err != nil {
			return nil, fmt.Errorf("parse person updated_at: %w", err)
		}
		person.CreatedAt = parsedCreatedAt
		person.UpdatedAt = parsedUpdatedAt

		peopleList = append(peopleList, person)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate people: %w", err)
	}

	return peopleList, nil
}
