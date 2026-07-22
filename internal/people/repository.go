package people

// Persists people records and joins associated company names.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// SQLRepository stores person records in the application database.
type SQLRepository struct {
	db *sql.DB
}

// NewSQLRepository creates a person repository backed by the provided database handle.
func NewSQLRepository(db *sql.DB) *SQLRepository {
	if db == nil {
		panic("people database is required")
	}
	return &SQLRepository{db: db}
}

// Count returns the total number of saved people.
func (r *SQLRepository) Count(ctx context.Context) (int, error) {
	row := r.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM people`)
	var count int
	if err := row.Scan(&count); err != nil {
		return 0, fmt.Errorf("count people: %w", err)
	}
	return count, nil
}

// Create inserts a new person row and returns the stored record.
func (r *SQLRepository) Create(ctx context.Context, input CreatePersonInput) (Person, error) {
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

	return r.GetByID(ctx, id)
}

// GetByID fetches one person by primary key.
func (r *SQLRepository) GetByID(ctx context.Context, id int64) (Person, error) {
	row := r.db.QueryRowContext(ctx, `
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
		WHERE p.id = ?
	`, id)

	return scanPerson(row)
}

// List returns people ordered by most recently updated first.
func (r *SQLRepository) List(ctx context.Context) ([]Person, error) {
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
		person, err := scanPerson(rows)
		if err != nil {
			return nil, err
		}
		peopleList = append(peopleList, person)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate people: %w", err)
	}

	return peopleList, nil
}

// ListCompanyCounts returns each company with the number of associated people.
func (r *SQLRepository) ListCompanyCounts(ctx context.Context) ([]CompanyCount, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT
			c.id,
			c.official_name,
			COUNT(p.id) AS person_count
		FROM companies c
		LEFT JOIN people p ON p.company_id = c.id
		GROUP BY c.id, c.official_name
		ORDER BY CASE WHEN COUNT(p.id) > 0 THEN 0 ELSE 1 END, LOWER(c.official_name)
	`)
	if err != nil {
		return nil, fmt.Errorf("list people company counts: %w", err)
	}
	defer rows.Close()

	counts := make([]CompanyCount, 0)
	for rows.Next() {
		var count CompanyCount
		if err := rows.Scan(&count.CompanyID, &count.CompanyName, &count.PersonCount); err != nil {
			return nil, fmt.Errorf("scan people company count row: %w", err)
		}
		count.CompanyName = strings.TrimSpace(count.CompanyName)
		counts = append(counts, count)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate people company counts: %w", err)
	}
	return counts, nil
}

// Update writes editable fields for an existing person and returns the fresh record.
func (r *SQLRepository) Update(ctx context.Context, input UpdatePersonInput) (Person, error) {
	result, err := r.db.ExecContext(ctx, `
		UPDATE people
		SET full_name = ?, title = ?, company_id = NULLIF(?, 0), linkedin_url = ?, notes = ?, updated_at = ?
		WHERE id = ?
	`,
		input.FullName,
		input.Title,
		input.CompanyID,
		input.LinkedInURL,
		input.Notes,
		time.Now().UTC().Format(time.RFC3339Nano),
		input.ID,
	)
	if err != nil {
		return Person{}, fmt.Errorf("update person: %w", err)
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return Person{}, fmt.Errorf("fetch updated person rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return Person{}, ErrPersonNotFound
	}

	return r.GetByID(ctx, input.ID)
}

// Delete removes a person from storage.
func (r *SQLRepository) Delete(ctx context.Context, id int64) error {
	result, err := r.db.ExecContext(ctx, `DELETE FROM people WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete person: %w", err)
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("fetch deleted person rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return ErrPersonNotFound
	}
	return nil
}

// personScanner abstracts sql.Row and sql.Rows scanning for shared person decoding.
type personScanner interface {
	Scan(dest ...any) error
}

// scanPerson decodes one person row, including joined company display data.
func scanPerson(scanner personScanner) (Person, error) {
	var person Person
	var createdAt string
	var updatedAt string
	if err := scanner.Scan(
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
		if errors.Is(err, sql.ErrNoRows) {
			return Person{}, ErrPersonNotFound
		}
		return Person{}, fmt.Errorf("scan person row: %w", err)
	}

	parsedCreatedAt, err := time.Parse(time.RFC3339Nano, createdAt)
	if err != nil {
		return Person{}, fmt.Errorf("parse person created_at: %w", err)
	}
	parsedUpdatedAt, err := time.Parse(time.RFC3339Nano, updatedAt)
	if err != nil {
		return Person{}, fmt.Errorf("parse person updated_at: %w", err)
	}
	person.CreatedAt = parsedCreatedAt
	person.UpdatedAt = parsedUpdatedAt

	return person, nil
}
