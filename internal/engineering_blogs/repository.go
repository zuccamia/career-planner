package engineering_blogs

// Persists engineering blog notes and aggregates company note counts.

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"
)

// SQLRepository stores engineering blog notes in the application database.
type SQLRepository struct {
	db *sql.DB
}

// NewSQLRepository creates an engineering blog repository backed by the provided database handle.
func NewSQLRepository(db *sql.DB) *SQLRepository {
	if db == nil {
		panic("engineering blogs database is required")
	}
	return &SQLRepository{db: db}
}

// Count returns the total number of saved engineering blog notes.
func (r *SQLRepository) Count(ctx context.Context) (int, error) {
	row := r.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM engineering_blog_notes`)
	var count int
	if err := row.Scan(&count); err != nil {
		return 0, fmt.Errorf("count engineering blog notes: %w", err)
	}
	return count, nil
}

// Create inserts a new engineering blog note row and returns the stored record.
func (r *SQLRepository) Create(ctx context.Context, input CreateInput) (Note, error) {
	now := time.Now().UTC()
	result, err := r.db.ExecContext(ctx, `
		INSERT INTO engineering_blog_notes (
			company_id,
			url,
			notes,
			created_at,
			updated_at
		) VALUES (?, ?, ?, ?, ?)
	`,
		input.CompanyID,
		input.URL,
		input.Notes,
		now.Format(time.RFC3339Nano),
		now.Format(time.RFC3339Nano),
	)
	if err != nil {
		return Note{}, fmt.Errorf("insert engineering blog note: %w", err)
	}

	id, err := result.LastInsertId()
	if err != nil {
		return Note{}, fmt.Errorf("fetch inserted engineering blog note id: %w", err)
	}

	return r.GetByID(ctx, id)
}

// List returns all engineering blog notes ordered by most recently updated first.
func (r *SQLRepository) List(ctx context.Context) ([]Note, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT
			n.id,
			n.company_id,
			c.official_name,
			n.url,
			n.notes,
			n.created_at,
			n.updated_at
		FROM engineering_blog_notes n
		JOIN companies c ON c.id = n.company_id
		ORDER BY n.updated_at DESC, n.id DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("list engineering blog notes: %w", err)
	}
	defer rows.Close()

	return scanEngineeringBlogNotes(rows)
}

// GetByID fetches one engineering blog note by primary key.
func (r *SQLRepository) GetByID(ctx context.Context, id int64) (Note, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT
			n.id,
			n.company_id,
			c.official_name,
			n.url,
			n.notes,
			n.created_at,
			n.updated_at
		FROM engineering_blog_notes n
		JOIN companies c ON c.id = n.company_id
		WHERE n.id = ?
	`, id)
	if err != nil {
		return Note{}, fmt.Errorf("get engineering blog note: %w", err)
	}
	defer rows.Close()

	notes, err := scanEngineeringBlogNotes(rows)
	if err != nil {
		return Note{}, err
	}
	if len(notes) == 0 {
		return Note{}, ErrNoteNotFound
	}
	return notes[0], nil
}

// ListByCompanyID returns engineering blog notes for one company ordered by most recently updated first.
func (r *SQLRepository) ListByCompanyID(ctx context.Context, companyID int64) ([]Note, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT
			n.id,
			n.company_id,
			c.official_name,
			n.url,
			n.notes,
			n.created_at,
			n.updated_at
		FROM engineering_blog_notes n
		JOIN companies c ON c.id = n.company_id
		WHERE n.company_id = ?
		ORDER BY n.updated_at DESC, n.id DESC
	`, companyID)
	if err != nil {
		return nil, fmt.Errorf("list engineering blog notes: %w", err)
	}
	defer rows.Close()

	return scanEngineeringBlogNotes(rows)
}

// Update writes editable fields for an existing engineering blog note and returns the fresh record.
func (r *SQLRepository) Update(ctx context.Context, input UpdateInput) (Note, error) {
	result, err := r.db.ExecContext(ctx, `
		UPDATE engineering_blog_notes
		SET company_id = ?, url = ?, notes = ?, updated_at = ?
		WHERE id = ?
	`, input.CompanyID, input.URL, input.Notes, time.Now().UTC().Format(time.RFC3339Nano), input.ID)
	if err != nil {
		return Note{}, fmt.Errorf("update engineering blog note: %w", err)
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return Note{}, fmt.Errorf("get updated engineering blog note rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return Note{}, ErrNoteNotFound
	}
	return r.GetByID(ctx, input.ID)
}

// Delete removes one engineering blog note by identifier.
func (r *SQLRepository) Delete(ctx context.Context, id int64) error {
	result, err := r.db.ExecContext(ctx, `DELETE FROM engineering_blog_notes WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete engineering blog note: %w", err)
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("get deleted engineering blog note rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return ErrNoteNotFound
	}
	return nil
}

// ListCompanyCounts returns each company with the number of associated engineering blog notes.
func (r *SQLRepository) ListCompanyCounts(ctx context.Context) ([]CompanyCount, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT
			c.id,
			c.official_name,
			COUNT(n.id) AS note_count
		FROM companies c
		LEFT JOIN engineering_blog_notes n ON n.company_id = c.id
		GROUP BY c.id, c.official_name
		ORDER BY CASE WHEN COUNT(n.id) > 0 THEN 0 ELSE 1 END, LOWER(c.official_name)
	`)
	if err != nil {
		return nil, fmt.Errorf("list engineering blog company counts: %w", err)
	}
	defer rows.Close()

	counts := make([]CompanyCount, 0)
	for rows.Next() {
		var count CompanyCount
		if err := rows.Scan(&count.CompanyID, &count.CompanyName, &count.NoteCount); err != nil {
			return nil, fmt.Errorf("scan engineering blog company count row: %w", err)
		}
		count.CompanyName = strings.TrimSpace(count.CompanyName)
		counts = append(counts, count)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate engineering blog company counts: %w", err)
	}
	return counts, nil
}

type scannerRows interface {
	Next() bool
	Scan(dest ...any) error
	Err() error
}

// scanEngineeringBlogNotes reads engineering blog note rows into domain models and parses timestamps.
func scanEngineeringBlogNotes(rows scannerRows) ([]Note, error) {
	notes := make([]Note, 0)
	for rows.Next() {
		var note Note
		var createdAt string
		var updatedAt string
		if err := rows.Scan(
			&note.ID,
			&note.CompanyID,
			&note.CompanyName,
			&note.URL,
			&note.Notes,
			&createdAt,
			&updatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan engineering blog note row: %w", err)
		}

		parsedCreatedAt, err := time.Parse(time.RFC3339Nano, createdAt)
		if err != nil {
			return nil, fmt.Errorf("parse engineering blog note created_at: %w", err)
		}
		parsedUpdatedAt, err := time.Parse(time.RFC3339Nano, updatedAt)
		if err != nil {
			return nil, fmt.Errorf("parse engineering blog note updated_at: %w", err)
		}
		note.CreatedAt = parsedCreatedAt
		note.UpdatedAt = parsedUpdatedAt

		notes = append(notes, note)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate engineering blog notes: %w", err)
	}

	return notes, nil
}
