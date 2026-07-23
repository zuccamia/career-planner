package applications

// Persists application records together with their timeline events and artifacts.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// SQLRepository stores application records in the application database.
type SQLRepository struct {
	db *sql.DB
}

// NewSQLRepository creates an applications repository backed by the provided database handle.
func NewSQLRepository(db *sql.DB) *SQLRepository {
	if db == nil {
		panic("applications database is required")
	}
	return &SQLRepository{db: db}
}

// Count returns the total number of saved applications.
func (r *SQLRepository) Count(ctx context.Context) (int, error) {
	row := r.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM applications`)
	var count int
	if err := row.Scan(&count); err != nil {
		return 0, fmt.Errorf("count applications: %w", err)
	}
	return count, nil
}

// CountByStatus returns the number of saved applications in one status.
func (r *SQLRepository) CountByStatus(ctx context.Context, status string) (int, error) {
	row := r.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM applications WHERE status = ?`, status)
	var count int
	if err := row.Scan(&count); err != nil {
		return 0, fmt.Errorf("count applications by status: %w", err)
	}
	return count, nil
}

// ListCompanyCounts returns each company with the number of associated applications.
func (r *SQLRepository) ListCompanyCounts(ctx context.Context) ([]CompanyCount, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT
			c.id,
			c.official_name,
			COUNT(a.id) AS application_count
		FROM companies c
		LEFT JOIN applications a ON a.company_id = c.id
		GROUP BY c.id, c.official_name
		ORDER BY CASE WHEN COUNT(a.id) > 0 THEN 0 ELSE 1 END, LOWER(c.official_name)
	`)
	if err != nil {
		return nil, fmt.Errorf("list applications company counts: %w", err)
	}
	defer rows.Close()

	counts := make([]CompanyCount, 0)
	for rows.Next() {
		var count CompanyCount
		if err := rows.Scan(&count.CompanyID, &count.CompanyName, &count.ApplicationCount); err != nil {
			return nil, fmt.Errorf("scan applications company count row: %w", err)
		}
		count.CompanyName = strings.TrimSpace(count.CompanyName)
		counts = append(counts, count)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate applications company counts: %w", err)
	}
	return counts, nil
}

// Create inserts a new application row and returns the stored record.
func (r *SQLRepository) Create(ctx context.Context, input CreateApplicationInput) (Application, error) {
	now := time.Now().UTC()
	result, err := r.db.ExecContext(ctx, `
		INSERT INTO applications (
			company_id,
			person_id,
			role_title,
			job_posting_url,
			job_description_raw,
			job_description_extracted_json,
			status,
			notes,
			created_at,
			updated_at
		) VALUES (?, NULLIF(?, 0), ?, ?, ?, ?, ?, ?, ?, ?)
	`,
		input.CompanyID,
		input.PersonID,
		input.RoleTitle,
		input.JobPostingURL,
		input.JobDescriptionRaw,
		input.JobDescriptionExtractedJSON,
		input.Status,
		input.Notes,
		now.Format(time.RFC3339Nano),
		now.Format(time.RFC3339Nano),
	)
	if err != nil {
		return Application{}, fmt.Errorf("insert application: %w", err)
	}

	id, err := result.LastInsertId()
	if err != nil {
		return Application{}, fmt.Errorf("fetch inserted application id: %w", err)
	}

	return r.GetByID(ctx, id)
}

// CreateEvent inserts one application event row and refreshes the parent application timestamp.
func (r *SQLRepository) CreateEvent(ctx context.Context, input CreateEventInput) (Event, error) {
	now := time.Now().UTC()
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return Event{}, fmt.Errorf("begin create application event: %w", err)
	}
	defer tx.Rollback()

	result, err := tx.ExecContext(ctx, `
		INSERT INTO application_events (
			application_id,
			type,
			content,
			from_status,
			to_status,
			occurred_at,
			created_at,
			updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`,
		input.ApplicationID,
		input.Type,
		input.Content,
		input.FromStatus,
		input.ToStatus,
		input.OccurredAt.Format(time.RFC3339Nano),
		now.Format(time.RFC3339Nano),
		now.Format(time.RFC3339Nano),
	)
	if err != nil {
		return Event{}, fmt.Errorf("insert application event: %w", err)
	}

	resultUpdate, err := tx.ExecContext(ctx, `UPDATE applications SET updated_at = ? WHERE id = ?`, now.Format(time.RFC3339Nano), input.ApplicationID)
	if err != nil {
		return Event{}, fmt.Errorf("touch application after event create: %w", err)
	}
	rowsAffected, err := resultUpdate.RowsAffected()
	if err != nil {
		return Event{}, fmt.Errorf("fetch touched application rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return Event{}, ErrApplicationNotFound
	}

	if err := tx.Commit(); err != nil {
		return Event{}, fmt.Errorf("commit application event create: %w", err)
	}

	eventID, err := result.LastInsertId()
	if err != nil {
		return Event{}, fmt.Errorf("fetch inserted application event id: %w", err)
	}

	return r.getEventByID(ctx, eventID)
}

// CreateArtifact inserts one application artifact row and refreshes the parent application timestamp.
func (r *SQLRepository) CreateArtifact(ctx context.Context, input CreateArtifactInput) (Artifact, error) {
	now := time.Now().UTC()
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return Artifact{}, fmt.Errorf("begin create application artifact: %w", err)
	}
	defer tx.Rollback()

	result, err := tx.ExecContext(ctx, `
		INSERT INTO application_artifacts (
			application_id,
			kind,
			label,
			storage_type,
			file_path,
			content,
			mime_type,
			created_at,
			updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`,
		input.ApplicationID,
		input.Kind,
		input.Label,
		input.StorageType,
		input.FilePath,
		input.Content,
		input.MimeType,
		now.Format(time.RFC3339Nano),
		now.Format(time.RFC3339Nano),
	)
	if err != nil {
		return Artifact{}, fmt.Errorf("insert application artifact: %w", err)
	}

	resultUpdate, err := tx.ExecContext(ctx, `UPDATE applications SET updated_at = ? WHERE id = ?`, now.Format(time.RFC3339Nano), input.ApplicationID)
	if err != nil {
		return Artifact{}, fmt.Errorf("touch application after artifact create: %w", err)
	}
	rowsAffected, err := resultUpdate.RowsAffected()
	if err != nil {
		return Artifact{}, fmt.Errorf("fetch touched application rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return Artifact{}, ErrApplicationNotFound
	}

	if err := tx.Commit(); err != nil {
		return Artifact{}, fmt.Errorf("commit application artifact create: %w", err)
	}

	artifactID, err := result.LastInsertId()
	if err != nil {
		return Artifact{}, fmt.Errorf("fetch inserted application artifact id: %w", err)
	}

	return r.getArtifactByID(ctx, artifactID)
}

// Delete removes one application row by identifier.
func (r *SQLRepository) Delete(ctx context.Context, id int64) error {
	result, err := r.db.ExecContext(ctx, `DELETE FROM applications WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete application: %w", err)
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("fetch deleted application rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return ErrApplicationNotFound
	}
	return nil
}

// GetByID fetches one application by primary key.
func (r *SQLRepository) GetByID(ctx context.Context, id int64) (Application, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT
			a.id,
			a.company_id,
			c.official_name,
			COALESCE(a.person_id, 0),
			COALESCE(p.full_name, ''),
			a.role_title,
			a.job_posting_url,
			a.job_description_raw,
			a.job_description_extracted_json,
			a.status,
			a.notes,
			a.created_at,
			a.updated_at,
			''
		FROM applications a
		JOIN companies c ON c.id = a.company_id
		LEFT JOIN people p ON p.id = a.person_id
		WHERE a.id = ?
	`, id)
	return scanApplication(row)
}

// List returns applications ordered by latest event first, then most recently updated.
func (r *SQLRepository) List(ctx context.Context) ([]Application, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT
			a.id,
			a.company_id,
			c.official_name,
			COALESCE(a.person_id, 0),
			COALESCE(p.full_name, ''),
			a.role_title,
			a.job_posting_url,
			a.job_description_raw,
			a.job_description_extracted_json,
			a.status,
			a.notes,
			a.created_at,
			a.updated_at,
			COALESCE(latest_event.occurred_at, '')
		FROM applications a
		JOIN companies c ON c.id = a.company_id
		LEFT JOIN people p ON p.id = a.person_id
		LEFT JOIN (
			SELECT application_id, MAX(occurred_at) AS occurred_at
			FROM application_events
			GROUP BY application_id
		) latest_event ON latest_event.application_id = a.id
		ORDER BY COALESCE(latest_event.occurred_at, a.updated_at) DESC, a.id DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("list applications: %w", err)
	}
	defer rows.Close()

	applicationsList := make([]Application, 0)
	for rows.Next() {
		application, err := scanApplication(rows)
		if err != nil {
			return nil, err
		}
		applicationsList = append(applicationsList, application)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate applications: %w", err)
	}

	return applicationsList, nil
}

// ListStatusTransitionCounts returns grouped status-change event counts across all applications.
func (r *SQLRepository) ListStatusTransitionCounts(ctx context.Context) ([]StatusTransitionCount, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT from_status, to_status, COUNT(*)
		FROM application_events
		WHERE type = 'status_changed'
		  AND from_status <> ''
		  AND to_status <> ''
		GROUP BY from_status, to_status
		ORDER BY COUNT(*) DESC, from_status, to_status
	`)
	if err != nil {
		return nil, fmt.Errorf("list application status transition counts: %w", err)
	}
	defer rows.Close()

	counts := make([]StatusTransitionCount, 0)
	for rows.Next() {
		var item StatusTransitionCount
		if err := rows.Scan(&item.FromStatus, &item.ToStatus, &item.Count); err != nil {
			return nil, fmt.Errorf("scan application status transition count row: %w", err)
		}
		item.FromStatus = strings.TrimSpace(item.FromStatus)
		item.ToStatus = strings.TrimSpace(item.ToStatus)
		counts = append(counts, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate application status transition counts: %w", err)
	}
	return counts, nil
}

// Update writes editable fields for an existing application and returns the fresh record.
func (r *SQLRepository) Update(ctx context.Context, input UpdateApplicationInput) (Application, error) {
	result, err := r.db.ExecContext(ctx, `
		UPDATE applications
		SET company_id = ?, person_id = NULLIF(?, 0), role_title = ?, job_posting_url = ?, job_description_raw = ?, job_description_extracted_json = ?, status = ?, notes = ?, updated_at = ?
		WHERE id = ?
	`,
		input.CompanyID,
		input.PersonID,
		input.RoleTitle,
		input.JobPostingURL,
		input.JobDescriptionRaw,
		input.JobDescriptionExtractedJSON,
		input.Status,
		input.Notes,
		time.Now().UTC().Format(time.RFC3339Nano),
		input.ID,
	)
	if err != nil {
		return Application{}, fmt.Errorf("update application: %w", err)
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return Application{}, fmt.Errorf("fetch updated application rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return Application{}, ErrApplicationNotFound
	}

	return r.GetByID(ctx, input.ID)
}

// UpdateStatus updates only the status and updated_at fields for one application.
func (r *SQLRepository) UpdateStatus(ctx context.Context, applicationID int64, status string) (Application, error) {
	result, err := r.db.ExecContext(ctx, `
		UPDATE applications
		SET status = ?, updated_at = ?
		WHERE id = ?
	`, status, time.Now().UTC().Format(time.RFC3339Nano), applicationID)
	if err != nil {
		return Application{}, fmt.Errorf("update application status: %w", err)
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return Application{}, fmt.Errorf("fetch updated application status rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return Application{}, ErrApplicationNotFound
	}

	return r.GetByID(ctx, applicationID)
}

// UpdateJobDescriptionExtractedJSON overwrites the structured job-description payload for one application.
func (r *SQLRepository) UpdateJobDescriptionRaw(ctx context.Context, applicationID int64, raw string) (Application, error) {
	if applicationID <= 0 {
		return Application{}, ErrApplicationNotFound
	}
	result, err := r.db.ExecContext(ctx, `
		UPDATE applications
		SET job_description_raw = ?, updated_at = ?
		WHERE id = ?
	`, strings.TrimSpace(raw), time.Now().UTC().Format(time.RFC3339Nano), applicationID)
	if err != nil {
		return Application{}, fmt.Errorf("update application job description raw: %w", err)
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return Application{}, fmt.Errorf("read updated application job description raw rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return Application{}, ErrApplicationNotFound
	}
	return r.GetByID(ctx, applicationID)
}

// UpdateJobDescriptionExtractedJSON overwrites the structured job-description payload for one application.
func (r *SQLRepository) UpdateJobDescriptionExtractedJSON(ctx context.Context, applicationID int64, extractedJSON string) (Application, error) {
	result, err := r.db.ExecContext(ctx, `
		UPDATE applications
		SET job_description_extracted_json = ?, updated_at = ?
		WHERE id = ?
	`, extractedJSON, time.Now().UTC().Format(time.RFC3339Nano), applicationID)
	if err != nil {
		return Application{}, fmt.Errorf("update application extracted job description: %w", err)
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return Application{}, fmt.Errorf("fetch updated application extracted job description rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return Application{}, ErrApplicationNotFound
	}
	return r.GetByID(ctx, applicationID)
}

// ListEventsByApplicationID returns timeline entries for one application ordered by occurrence.
func (r *SQLRepository) ListEventsByApplicationID(ctx context.Context, applicationID int64) ([]Event, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, application_id, type, content, from_status, to_status, occurred_at, created_at, updated_at
		FROM application_events
		WHERE application_id = ?
		ORDER BY occurred_at DESC, id DESC
	`, applicationID)
	if err != nil {
		return nil, fmt.Errorf("list application events: %w", err)
	}
	defer rows.Close()

	events := make([]Event, 0)
	for rows.Next() {
		event, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		events = append(events, event)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate application events: %w", err)
	}

	return events, nil
}

// ListDailyAppliedCounts returns per-day counts of application events that transition into applied.
func (r *SQLRepository) ListDailyAppliedCounts(ctx context.Context, from, to time.Time) ([]DailyCount, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT substr(occurred_at, 1, 10) AS day, COUNT(*)
		FROM application_events
		WHERE type = 'status_changed'
		  AND to_status = 'applied'
		  AND occurred_at >= ?
		  AND occurred_at < ?
		GROUP BY substr(occurred_at, 1, 10)
		ORDER BY day ASC
	`, from.Format(time.RFC3339Nano), to.Format(time.RFC3339Nano))
	if err != nil {
		return nil, fmt.Errorf("list daily applied application counts: %w", err)
	}
	defer rows.Close()

	counts := make([]DailyCount, 0)
	for rows.Next() {
		var day string
		var count DailyCount
		if err := rows.Scan(&day, &count.Count); err != nil {
			return nil, fmt.Errorf("scan daily applied application count row: %w", err)
		}
		count.Day, err = time.Parse("2006-01-02", day)
		if err != nil {
			return nil, fmt.Errorf("parse daily applied application count day: %w", err)
		}
		counts = append(counts, count)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate daily applied application counts: %w", err)
	}
	return counts, nil
}

// ListArtifactsByApplicationID returns artifacts for one application ordered by newest first.
func (r *SQLRepository) ListArtifactsByApplicationID(ctx context.Context, applicationID int64) ([]Artifact, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, application_id, kind, label, storage_type, file_path, content, mime_type, created_at, updated_at
		FROM application_artifacts
		WHERE application_id = ?
		ORDER BY created_at DESC, id DESC
	`, applicationID)
	if err != nil {
		return nil, fmt.Errorf("list application artifacts: %w", err)
	}
	defer rows.Close()

	artifacts := make([]Artifact, 0)
	for rows.Next() {
		artifact, err := scanArtifact(rows)
		if err != nil {
			return nil, err
		}
		artifacts = append(artifacts, artifact)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate application artifacts: %w", err)
	}

	return artifacts, nil
}

func (r *SQLRepository) getEventByID(ctx context.Context, id int64) (Event, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id, application_id, type, content, from_status, to_status, occurred_at, created_at, updated_at
		FROM application_events
		WHERE id = ?
	`, id)
	return scanEvent(row)
}

func (r *SQLRepository) getArtifactByID(ctx context.Context, id int64) (Artifact, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id, application_id, kind, label, storage_type, file_path, content, mime_type, created_at, updated_at
		FROM application_artifacts
		WHERE id = ?
	`, id)
	return scanArtifact(row)
}

type applicationScanner interface {
	Scan(dest ...any) error
}

func scanApplication(scanner applicationScanner) (Application, error) {
	var application Application
	var createdAt string
	var updatedAt string
	var latestEventAt string
	if err := scanner.Scan(
		&application.ID,
		&application.CompanyID,
		&application.CompanyName,
		&application.PersonID,
		&application.PersonName,
		&application.RoleTitle,
		&application.JobPostingURL,
		&application.JobDescriptionRaw,
		&application.JobDescriptionExtractedJSON,
		&application.Status,
		&application.Notes,
		&createdAt,
		&updatedAt,
		&latestEventAt,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Application{}, ErrApplicationNotFound
		}
		return Application{}, fmt.Errorf("scan application row: %w", err)
	}

	parsedCreatedAt, err := time.Parse(time.RFC3339Nano, createdAt)
	if err != nil {
		return Application{}, fmt.Errorf("parse application created_at: %w", err)
	}
	parsedUpdatedAt, err := time.Parse(time.RFC3339Nano, updatedAt)
	if err != nil {
		return Application{}, fmt.Errorf("parse application updated_at: %w", err)
	}

	application.CreatedAt = parsedCreatedAt
	application.UpdatedAt = parsedUpdatedAt
	if strings.TrimSpace(latestEventAt) != "" {
		parsedLatestEventAt, err := time.Parse(time.RFC3339Nano, latestEventAt)
		if err != nil {
			return Application{}, fmt.Errorf("parse application latest_event_at: %w", err)
		}
		application.LatestEventAt = parsedLatestEventAt
	}

	return application, nil
}

type eventScanner interface {
	Scan(dest ...any) error
}

func scanEvent(scanner eventScanner) (Event, error) {
	var event Event
	var occurredAt string
	var createdAt string
	var updatedAt string
	if err := scanner.Scan(
		&event.ID,
		&event.ApplicationID,
		&event.Type,
		&event.Content,
		&event.FromStatus,
		&event.ToStatus,
		&occurredAt,
		&createdAt,
		&updatedAt,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Event{}, ErrApplicationNotFound
		}
		return Event{}, fmt.Errorf("scan application event row: %w", err)
	}

	parsedOccurredAt, err := time.Parse(time.RFC3339Nano, occurredAt)
	if err != nil {
		return Event{}, fmt.Errorf("parse application event occurred_at: %w", err)
	}
	parsedCreatedAt, err := time.Parse(time.RFC3339Nano, createdAt)
	if err != nil {
		return Event{}, fmt.Errorf("parse application event created_at: %w", err)
	}
	parsedUpdatedAt, err := time.Parse(time.RFC3339Nano, updatedAt)
	if err != nil {
		return Event{}, fmt.Errorf("parse application event updated_at: %w", err)
	}

	event.OccurredAt = parsedOccurredAt
	event.CreatedAt = parsedCreatedAt
	event.UpdatedAt = parsedUpdatedAt

	return event, nil
}

type artifactScanner interface {
	Scan(dest ...any) error
}

func scanArtifact(scanner artifactScanner) (Artifact, error) {
	var artifact Artifact
	var createdAt string
	var updatedAt string
	if err := scanner.Scan(
		&artifact.ID,
		&artifact.ApplicationID,
		&artifact.Kind,
		&artifact.Label,
		&artifact.StorageType,
		&artifact.FilePath,
		&artifact.Content,
		&artifact.MimeType,
		&createdAt,
		&updatedAt,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Artifact{}, ErrApplicationNotFound
		}
		return Artifact{}, fmt.Errorf("scan application artifact row: %w", err)
	}

	parsedCreatedAt, err := time.Parse(time.RFC3339Nano, createdAt)
	if err != nil {
		return Artifact{}, fmt.Errorf("parse application artifact created_at: %w", err)
	}
	parsedUpdatedAt, err := time.Parse(time.RFC3339Nano, updatedAt)
	if err != nil {
		return Artifact{}, fmt.Errorf("parse application artifact updated_at: %w", err)
	}

	artifact.CreatedAt = parsedCreatedAt
	artifact.UpdatedAt = parsedUpdatedAt

	return artifact, nil
}
