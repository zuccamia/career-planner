package communications

// Persists communication threads and entries in the application database.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// SQLRepository stores communication threads and entries in the application database.
type SQLRepository struct {
	db *sql.DB
}

// NewSQLRepository creates a communications repository backed by the provided database handle.
func NewSQLRepository(db *sql.DB) *SQLRepository {
	if db == nil {
		panic("communications database is required")
	}
	return &SQLRepository{db: db}
}

// Count returns the total number of saved communication threads.
func (r *SQLRepository) Count(ctx context.Context) (int, error) {
	row := r.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM communication_threads`)
	var count int
	if err := row.Scan(&count); err != nil {
		return 0, fmt.Errorf("count communication threads: %w", err)
	}
	return count, nil
}

// CreateThread inserts a new communication thread and touches the related person record.
func (r *SQLRepository) CreateThread(ctx context.Context, input CreateThreadInput) (Thread, error) {
	now := time.Now().UTC()
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return Thread{}, fmt.Errorf("begin create communication thread: %w", err)
	}
	defer tx.Rollback()

	result, err := tx.ExecContext(ctx, `
		INSERT INTO communication_threads (
			person_id,
			channel,
			subject,
			status,
			summary,
			last_activity_at,
			created_at,
			updated_at
		) VALUES (?, ?, ?, 'open', '', ?, ?, ?)
	`, input.PersonID, input.Channel, input.Subject, input.OccurredAt.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano))
	if err != nil {
		return Thread{}, fmt.Errorf("insert communication thread: %w", err)
	}
	threadID, err := result.LastInsertId()
	if err != nil {
		return Thread{}, fmt.Errorf("fetch inserted communication thread id: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE people SET updated_at = ? WHERE id = ?`, now.Format(time.RFC3339Nano), input.PersonID); err != nil {
		return Thread{}, fmt.Errorf("touch person after communication thread create: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Thread{}, fmt.Errorf("commit communication thread create: %w", err)
	}
	return r.GetThreadByID(ctx, threadID)
}

// CreateEntry inserts a thread entry and updates the parent thread activity timestamp.
func (r *SQLRepository) CreateEntry(ctx context.Context, input CreateEntryInput) (Entry, error) {
	now := time.Now().UTC()
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return Entry{}, fmt.Errorf("begin create communication entry: %w", err)
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `
		INSERT INTO communication_entries (
			thread_id,
			direction,
			content,
			occurred_at,
			created_at,
			updated_at
		) VALUES (?, ?, ?, ?, ?, ?)
	`, input.ThreadID, input.Direction, input.Content, input.OccurredAt.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano))
	if err != nil {
		return Entry{}, fmt.Errorf("insert communication entry: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE communication_threads
		SET status = 'open', last_activity_at = ?, updated_at = ?
		WHERE id = ?
	`, input.OccurredAt.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano), input.ThreadID); err != nil {
		return Entry{}, fmt.Errorf("update communication thread activity: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Entry{}, fmt.Errorf("commit communication entry create: %w", err)
	}
	entryID, err := result.LastInsertId()
	if err != nil {
		return Entry{}, fmt.Errorf("fetch inserted communication entry id: %w", err)
	}
	return r.getEntryByID(ctx, entryID)
}

// UpdateThread updates editable fields on an existing communication thread.
func (r *SQLRepository) UpdateThread(ctx context.Context, input UpdateThreadInput) (Thread, error) {
	result, err := r.db.ExecContext(ctx, `
		UPDATE communication_threads
		SET channel = ?, subject = ?, updated_at = ?
		WHERE id = ?
	`, input.Channel, input.Subject, time.Now().UTC().Format(time.RFC3339Nano), input.ThreadID)
	if err != nil {
		return Thread{}, fmt.Errorf("update communication thread: %w", err)
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return Thread{}, fmt.Errorf("fetch communication thread update rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return Thread{}, ErrThreadNotFound
	}
	return r.GetThreadByID(ctx, input.ThreadID)
}

// DeleteEntry removes one thread entry and refreshes the parent thread activity timestamp.
func (r *SQLRepository) DeleteEntry(ctx context.Context, id int64) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin delete communication entry: %w", err)
	}
	defer tx.Rollback()

	var threadID int64
	if err := tx.QueryRowContext(ctx, `SELECT thread_id FROM communication_entries WHERE id = ?`, id).Scan(&threadID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrEntryNotFound
		}
		return fmt.Errorf("find communication entry thread: %w", err)
	}

	result, err := tx.ExecContext(ctx, `DELETE FROM communication_entries WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete communication entry: %w", err)
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("fetch communication entry delete rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return ErrEntryNotFound
	}

	var activityAt string
	err = tx.QueryRowContext(ctx, `
		SELECT COALESCE(
			(SELECT occurred_at FROM communication_entries WHERE thread_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 1),
			(SELECT created_at FROM communication_threads WHERE id = ?)
		)
	`, threadID, threadID).Scan(&activityAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrThreadNotFound
		}
		return fmt.Errorf("lookup communication thread activity after entry delete: %w", err)
	}

	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err = tx.ExecContext(ctx, `
		UPDATE communication_threads
		SET last_activity_at = ?, updated_at = ?
		WHERE id = ?
	`, activityAt, now, threadID)
	if err != nil {
		return fmt.Errorf("update communication thread after entry delete: %w", err)
	}
	rowsAffected, err = result.RowsAffected()
	if err != nil {
		return fmt.Errorf("fetch communication thread update rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return ErrThreadNotFound
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit communication entry delete: %w", err)
	}
	return nil
}

// GetThreadByID returns one communication thread by identifier.
func (r *SQLRepository) GetThreadByID(ctx context.Context, id int64) (Thread, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT
			t.id,
			t.person_id,
			COALESCE(p.full_name, ''),
			p.notes,
			t.channel,
			t.subject,
			t.status,
			t.summary,
			t.summary_updated_at,
			t.last_activity_at,
			t.created_at,
			t.updated_at
		FROM communication_threads t
		JOIN people p ON p.id = t.person_id
		WHERE t.id = ?
	`, id)
	return scanThread(row)
}

// GetThreadDetail returns one thread together with all of its entries ordered by occurrence.
func (r *SQLRepository) GetThreadDetail(ctx context.Context, id int64) (ThreadDetail, error) {
	thread, err := r.GetThreadByID(ctx, id)
	if err != nil {
		return ThreadDetail{}, err
	}
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, thread_id, direction, content, occurred_at, created_at, updated_at
		FROM communication_entries
		WHERE thread_id = ?
		ORDER BY occurred_at DESC, id DESC
	`, id)
	if err != nil {
		return ThreadDetail{}, fmt.Errorf("list communication entries: %w", err)
	}
	defer rows.Close()
	entries := make([]Entry, 0)
	for rows.Next() {
		entry, err := scanEntry(rows)
		if err != nil {
			return ThreadDetail{}, err
		}
		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		return ThreadDetail{}, fmt.Errorf("iterate communication entries: %w", err)
	}
	return ThreadDetail{Thread: thread, Entries: entries}, nil
}

// ListThreadsByPersonID returns all threads associated with one person ordered by recent activity.
func (r *SQLRepository) ListThreadsByPersonID(ctx context.Context, personID int64) ([]Thread, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT
			t.id,
			t.person_id,
			COALESCE(p.full_name, ''),
			p.notes,
			t.channel,
			t.subject,
			t.status,
			t.summary,
			t.summary_updated_at,
			t.last_activity_at,
			t.created_at,
			t.updated_at
		FROM communication_threads t
		JOIN people p ON p.id = t.person_id
		WHERE t.person_id = ?
		ORDER BY t.last_activity_at DESC, t.id DESC
	`, personID)
	if err != nil {
		return nil, fmt.Errorf("list communication threads: %w", err)
	}
	defer rows.Close()
	threads := make([]Thread, 0)
	for rows.Next() {
		thread, err := scanThread(rows)
		if err != nil {
			return nil, err
		}
		threads = append(threads, thread)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate communication threads: %w", err)
	}
	return threads, nil
}

// ListDailyEntryCounts returns per-day counts of communication entries in the requested range.
func (r *SQLRepository) ListDailyEntryCounts(ctx context.Context, from, to time.Time) ([]DailyCount, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT substr(occurred_at, 1, 10) AS day, COUNT(*)
		FROM communication_entries
		WHERE occurred_at >= ?
		  AND occurred_at < ?
		GROUP BY substr(occurred_at, 1, 10)
		ORDER BY day ASC
	`, from.Format(time.RFC3339Nano), to.Format(time.RFC3339Nano))
	if err != nil {
		return nil, fmt.Errorf("list daily communication entry counts: %w", err)
	}
	defer rows.Close()

	counts := make([]DailyCount, 0)
	for rows.Next() {
		var day string
		var count DailyCount
		if err := rows.Scan(&day, &count.Count); err != nil {
			return nil, fmt.Errorf("scan daily communication entry count row: %w", err)
		}
		count.Day, err = time.Parse("2006-01-02", day)
		if err != nil {
			return nil, fmt.Errorf("parse daily communication entry count day: %w", err)
		}
		counts = append(counts, count)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate daily communication entry counts: %w", err)
	}
	return counts, nil
}

// UpdateThreadStatus persists a new status for one communication thread.
func (r *SQLRepository) UpdateThreadStatus(ctx context.Context, threadID int64, status string) (Thread, error) {
	result, err := r.db.ExecContext(ctx, `
		UPDATE communication_threads
		SET status = ?, updated_at = ?
		WHERE id = ?
	`, status, time.Now().UTC().Format(time.RFC3339Nano), threadID)
	if err != nil {
		return Thread{}, fmt.Errorf("update communication thread status: %w", err)
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return Thread{}, fmt.Errorf("fetch communication thread status rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return Thread{}, ErrThreadNotFound
	}
	return r.GetThreadByID(ctx, threadID)
}

// UpdateThreadSummary persists an LLM-generated summary and its refresh timestamp.
func (r *SQLRepository) UpdateThreadSummary(ctx context.Context, input UpdateSummaryInput) (Thread, error) {
	result, err := r.db.ExecContext(ctx, `
		UPDATE communication_threads
		SET summary = ?, summary_updated_at = ?, updated_at = ?
		WHERE id = ?
	`, input.Summary, input.SummaryUpdatedAt.Format(time.RFC3339Nano), time.Now().UTC().Format(time.RFC3339Nano), input.ThreadID)
	if err != nil {
		return Thread{}, fmt.Errorf("update communication thread summary: %w", err)
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return Thread{}, fmt.Errorf("fetch communication thread summary rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return Thread{}, ErrThreadNotFound
	}
	return r.GetThreadByID(ctx, input.ThreadID)
}

type threadScanner interface{ Scan(dest ...any) error }
type entryScanner interface{ Scan(dest ...any) error }

// scanThread maps one communication thread row into a Thread value.
func scanThread(scanner threadScanner) (Thread, error) {
	var thread Thread
	var summaryUpdatedAt sql.NullString
	var lastActivityAt string
	var createdAt string
	var updatedAt string
	if err := scanner.Scan(&thread.ID, &thread.PersonID, &thread.PersonName, &thread.PersonNotes, &thread.Channel, &thread.Subject, &thread.Status, &thread.Summary, &summaryUpdatedAt, &lastActivityAt, &createdAt, &updatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Thread{}, ErrThreadNotFound
		}
		return Thread{}, fmt.Errorf("scan communication thread row: %w", err)
	}
	parsedLastActivityAt, err := time.Parse(time.RFC3339Nano, lastActivityAt)
	if err != nil {
		return Thread{}, fmt.Errorf("parse communication thread last_activity_at: %w", err)
	}
	parsedCreatedAt, err := time.Parse(time.RFC3339Nano, createdAt)
	if err != nil {
		return Thread{}, fmt.Errorf("parse communication thread created_at: %w", err)
	}
	parsedUpdatedAt, err := time.Parse(time.RFC3339Nano, updatedAt)
	if err != nil {
		return Thread{}, fmt.Errorf("parse communication thread updated_at: %w", err)
	}
	thread.LastActivityAt = parsedLastActivityAt
	thread.CreatedAt = parsedCreatedAt
	thread.UpdatedAt = parsedUpdatedAt
	if summaryUpdatedAt.Valid {
		parsedSummaryUpdatedAt, err := time.Parse(time.RFC3339Nano, summaryUpdatedAt.String)
		if err != nil {
			return Thread{}, fmt.Errorf("parse communication thread summary_updated_at: %w", err)
		}
		thread.SummaryUpdatedAt = &parsedSummaryUpdatedAt
	}
	return thread, nil
}

// scanEntry maps one communication entry row into an Entry value.
func scanEntry(scanner entryScanner) (Entry, error) {
	var entry Entry
	var occurredAt, createdAt, updatedAt string
	if err := scanner.Scan(&entry.ID, &entry.ThreadID, &entry.Direction, &entry.Content, &occurredAt, &createdAt, &updatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Entry{}, ErrThreadNotFound
		}
		return Entry{}, fmt.Errorf("scan communication entry row: %w", err)
	}
	parsedOccurredAt, err := time.Parse(time.RFC3339Nano, occurredAt)
	if err != nil {
		return Entry{}, fmt.Errorf("parse communication entry occurred_at: %w", err)
	}
	parsedCreatedAt, err := time.Parse(time.RFC3339Nano, createdAt)
	if err != nil {
		return Entry{}, fmt.Errorf("parse communication entry created_at: %w", err)
	}
	parsedUpdatedAt, err := time.Parse(time.RFC3339Nano, updatedAt)
	if err != nil {
		return Entry{}, fmt.Errorf("parse communication entry updated_at: %w", err)
	}
	entry.OccurredAt = parsedOccurredAt
	entry.CreatedAt = parsedCreatedAt
	entry.UpdatedAt = parsedUpdatedAt
	return entry, nil
}

func (r *SQLRepository) getEntryByID(ctx context.Context, id int64) (Entry, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id, thread_id, direction, content, occurred_at, created_at, updated_at
		FROM communication_entries
		WHERE id = ?
	`, id)
	return scanEntry(row)
}
