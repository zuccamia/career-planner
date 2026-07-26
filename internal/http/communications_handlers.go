package http

// Serves communication thread pages, entry forms, generation actions, and summary actions.

import (
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/ngochoang/career-planner/internal/communications"
	"github.com/ngochoang/career-planner/internal/people"
)

// communicationThreadEdit renders the edit form for one communication thread.
func (s *Server) communicationThreadEdit(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		http.NotFound(w, r)
		return
	}
	s.renderCommunicationThreadEditForm(w, r, id, nil)
}

// communicationThreadUpdate persists editable thread fields.
func (s *Server) communicationThreadUpdate(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		http.NotFound(w, r)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "invalid form", http.StatusBadRequest)
		return
	}
	_, err = s.communications.UpdateThread(r.Context(), communications.UpdateThreadInput{
		ThreadID: id,
		Channel:  r.FormValue("channel"),
		Subject:  r.FormValue("subject"),
	})
	if err == nil {
		http.Redirect(w, r, "/communication-threads/"+strconv.FormatInt(id, 10), http.StatusSeeOther)
		return
	}
	if errors.Is(err, communications.ErrThreadNotFound) {
		http.NotFound(w, r)
		return
	}
	s.renderCommunicationThreadEditForm(w, r, id, map[string]any{
		"ThreadError":   err.Error(),
		"ThreadSubject": strings.TrimSpace(r.FormValue("subject")),
		"ThreadChannel": strings.TrimSpace(r.FormValue("channel")),
	})
}

// communicationThreadCreate creates a new communication thread for one person.
func (s *Server) communicationThreadCreate(w http.ResponseWriter, r *http.Request) {
	personID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || personID <= 0 {
		http.NotFound(w, r)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "invalid form", http.StatusBadRequest)
		return
	}
	thread, err := s.communications.CreateThread(r.Context(), communications.CreateThreadInput{
		PersonID:   personID,
		Channel:    r.FormValue("channel"),
		Subject:    r.FormValue("subject"),
		OccurredAt: parseOccurredAt(r.FormValue("occurred_at")),
	})
	if err == nil {
		http.Redirect(w, r, "/communication-threads/"+strconv.FormatInt(thread.ID, 10), http.StatusSeeOther)
		return
	}
	person, getErr := s.people.GetByID(r.Context(), personID)
	if getErr != nil {
		if errors.Is(getErr, people.ErrPersonNotFound) {
			http.NotFound(w, r)
			return
		}
		log.Printf("get person for communication thread error state: %v", getErr)
		http.Error(w, "could not load person", http.StatusInternalServerError)
		return
	}
	threads, listErr := s.communications.ListThreadsByPersonID(r.Context(), personID)
	if listErr != nil && !errors.Is(listErr, communications.ErrThreadNotFound) {
		log.Printf("list communication threads for error state: %v", listErr)
		http.Error(w, "could not load person", http.StatusInternalServerError)
		return
	}
	data := map[string]any{
		"Title":            person.FullName,
		"ActiveNav":        "people",
		"Person":           person,
		"Threads":          buildPersonThreadCardViews(threads),
		"HasThreads":       len(threads) > 0,
		"HasLinkedInURL":   strings.TrimSpace(person.LinkedInURL) != "",
		"ThreadError":      err.Error(),
		"ThreadSubject":    strings.TrimSpace(r.FormValue("subject")),
		"ThreadChannel":    strings.TrimSpace(r.FormValue("channel")),
		"ThreadOccurredAt": strings.TrimSpace(r.FormValue("occurred_at")),
	}
	if err := s.render(w, r, "person_show.html", data); err != nil {
		log.Printf("render communication thread create error state: %v", err)
	}
}

// communicationThreadShow renders one communication thread with its entries and tools.
func (s *Server) communicationThreadShow(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		http.NotFound(w, r)
		return
	}
	detail, err := s.communications.GetThreadDetail(r.Context(), id)
	if err != nil {
		if errors.Is(err, communications.ErrThreadNotFound) {
			http.NotFound(w, r)
			return
		}
		log.Printf("get communication thread detail: %v", err)
		http.Error(w, "could not load communication thread", http.StatusInternalServerError)
		return
	}
	data := map[string]any{
		"Title":               detail.Thread.Subject,
		"ActiveNav":           "people",
		"Thread":              detail.Thread,
		"Entries":             detail.Entries,
		"HasEntries":          len(detail.Entries) > 0,
		"IsClosed":            detail.Thread.Status == "closed",
		"HasSummary":          strings.TrimSpace(detail.Thread.Summary) != "",
		"HasSummaryUpdatedAt": detail.Thread.SummaryUpdatedAt != nil,
	}
	if err := s.render(w, r, "communication_thread_show.html", data); err != nil {
		log.Printf("render communication thread show: %v", err)
	}
}

// communicationThreadClose marks one communication thread as closed.
func (s *Server) communicationThreadClose(w http.ResponseWriter, r *http.Request) {
	s.updateCommunicationThreadStatus(w, r, "closed")
}

// communicationThreadReopen marks one communication thread as open again.
func (s *Server) communicationThreadReopen(w http.ResponseWriter, r *http.Request) {
	s.updateCommunicationThreadStatus(w, r, "open")
}

// communicationEntryNewForm renders the add-entry form for one thread.
func (s *Server) communicationEntryNewForm(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		http.NotFound(w, r)
		return
	}
	s.renderCommunicationEntryForm(w, r, id, map[string]any{})
}

// communicationEntryCreate appends one manual entry to an existing thread.
func (s *Server) communicationEntryCreate(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		http.NotFound(w, r)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "invalid form", http.StatusBadRequest)
		return
	}
	_, err = s.communications.CreateEntry(r.Context(), communications.CreateEntryInput{
		ThreadID:   id,
		Direction:  r.FormValue("direction"),
		Content:    r.FormValue("content"),
		OccurredAt: parseOccurredAt(r.FormValue("occurred_at")),
	})
	if err != nil {
		s.renderCommunicationEntryForm(w, r, id, map[string]any{
			"EntryError":      err.Error(),
			"EntryDirection":  strings.TrimSpace(r.FormValue("direction")),
			"EntryOccurredAt": strings.TrimSpace(r.FormValue("occurred_at")),
			"EntryContent":    strings.TrimSpace(r.FormValue("content")),
		})
		return
	}
	http.Redirect(w, r, "/communication-threads/"+strconv.FormatInt(id, 10), http.StatusSeeOther)
}

// communicationThreadSummarize generates and saves a thread summary on demand.
func (s *Server) communicationThreadSummarize(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		http.NotFound(w, r)
		return
	}
	_, err = s.communications.SummarizeThread(r.Context(), id)
	if err == nil {
		http.Redirect(w, r, "/communication-threads/"+strconv.FormatInt(id, 10), http.StatusSeeOther)
		return
	}
	s.renderCommunicationThreadError(w, r, id, "SummaryError", err.Error())
}

// communicationMessageGenerate drafts one outreach or reply message for a thread.
func (s *Server) communicationMessageGenerate(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		http.NotFound(w, r)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "invalid form", http.StatusBadRequest)
		return
	}
	goal := strings.TrimSpace(r.FormValue("goal"))
	returnTo := strings.TrimSpace(r.FormValue("return_to"))
	message, err := s.communications.GenerateMessage(r.Context(), communications.GenerateMessageInput{
		ThreadID: id,
		Goal:     goal,
	})
	if err == nil {
		if returnTo == "entry-form" {
			s.renderCommunicationEntryForm(w, r, id, map[string]any{
				"GeneratedMessage": message,
				"GeneratedGoal":    goal,
			})
			return
		}
		s.renderCommunicationThreadGenerated(w, r, id, goal, message)
		return
	}
	if returnTo == "entry-form" {
		s.renderCommunicationEntryForm(w, r, id, map[string]any{
			"GenerateError": err.Error(),
		})
		return
	}
	s.renderCommunicationThreadError(w, r, id, "GenerateError", err.Error())
}

// communicationGeneratedEntryCreate saves a generated message back into the thread as an outbound entry.
func (s *Server) communicationGeneratedEntryCreate(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		http.NotFound(w, r)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "invalid form", http.StatusBadRequest)
		return
	}
	message := strings.TrimSpace(r.FormValue("generated_message"))
	returnTo := strings.TrimSpace(r.FormValue("return_to"))
	if message == "" {
		if returnTo == "entry-form" {
			s.renderCommunicationEntryForm(w, r, id, map[string]any{
				"GenerateError": "generated message is required",
			})
			return
		}
		s.renderCommunicationThreadError(w, r, id, "GenerateError", "generated message is required")
		return
	}
	_, err = s.communications.CreateEntry(r.Context(), communications.CreateEntryInput{
		ThreadID:   id,
		Direction:  "outbound",
		Content:    message,
		OccurredAt: time.Now().UTC(),
	})
	if err != nil {
		if returnTo == "entry-form" {
			s.renderCommunicationEntryForm(w, r, id, map[string]any{
				"GenerateError":    err.Error(),
				"GeneratedMessage": message,
			})
			return
		}
		s.renderCommunicationThreadError(w, r, id, "GenerateError", err.Error())
		return
	}
	if returnTo == "entry-form" {
		http.Redirect(w, r, "/communication-threads/"+strconv.FormatInt(id, 10)+"/entries/new", http.StatusSeeOther)
		return
	}
	http.Redirect(w, r, "/communication-threads/"+strconv.FormatInt(id, 10), http.StatusSeeOther)
}

// communicationEntryDelete removes one entry and redirects back to its thread.
func (s *Server) communicationEntryDelete(w http.ResponseWriter, r *http.Request) {
	entryID, err := strconv.ParseInt(r.PathValue("entryID"), 10, 64)
	if err != nil || entryID <= 0 {
		http.NotFound(w, r)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "invalid form", http.StatusBadRequest)
		return
	}
	threadID, err := strconv.ParseInt(r.FormValue("thread_id"), 10, 64)
	if err != nil || threadID <= 0 {
		http.NotFound(w, r)
		return
	}
	if err := s.communications.DeleteEntry(r.Context(), entryID); err != nil {
		if errors.Is(err, communications.ErrEntryNotFound) || errors.Is(err, communications.ErrThreadNotFound) {
			http.NotFound(w, r)
			return
		}
		log.Printf("delete communication entry: %v", err)
		http.Error(w, "could not delete communication entry", http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, "/communication-threads/"+strconv.FormatInt(threadID, 10), http.StatusSeeOther)
}

// renderCommunicationThreadError re-renders the thread page with one scoped error message.
func (s *Server) renderCommunicationThreadError(w http.ResponseWriter, r *http.Request, threadID int64, key, value string) {
	detail, err := s.communications.GetThreadDetail(r.Context(), threadID)
	if err != nil {
		if errors.Is(err, communications.ErrThreadNotFound) {
			http.NotFound(w, r)
			return
		}
		log.Printf("get communication thread detail for error state: %v", err)
		http.Error(w, "could not load communication thread", http.StatusInternalServerError)
		return
	}
	data := map[string]any{
		"Title":               detail.Thread.Subject,
		"ActiveNav":           "people",
		"Thread":              detail.Thread,
		"Entries":             detail.Entries,
		"HasEntries":          len(detail.Entries) > 0,
		"IsClosed":            detail.Thread.Status == "closed",
		"HasSummary":          strings.TrimSpace(detail.Thread.Summary) != "",
		"HasSummaryUpdatedAt": detail.Thread.SummaryUpdatedAt != nil,
		key:                   value,
	}
	if err := s.render(w, r, "communication_thread_show.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// renderCommunicationThreadGenerated re-renders the thread page including one generated draft.
func (s *Server) renderCommunicationThreadGenerated(w http.ResponseWriter, r *http.Request, threadID int64, goal, message string) {
	detail, err := s.communications.GetThreadDetail(r.Context(), threadID)
	if err != nil {
		if errors.Is(err, communications.ErrThreadNotFound) {
			http.NotFound(w, r)
			return
		}
		log.Printf("get communication thread detail for generated state: %v", err)
		http.Error(w, "could not load communication thread", http.StatusInternalServerError)
		return
	}
	data := map[string]any{
		"Title":               detail.Thread.Subject,
		"ActiveNav":           "people",
		"Thread":              detail.Thread,
		"Entries":             detail.Entries,
		"HasEntries":          len(detail.Entries) > 0,
		"IsClosed":            detail.Thread.Status == "closed",
		"HasSummary":          strings.TrimSpace(detail.Thread.Summary) != "",
		"HasSummaryUpdatedAt": detail.Thread.SummaryUpdatedAt != nil,
		"GeneratedMessage":    message,
		"GeneratedGoal":       goal,
	}
	if err := s.render(w, r, "communication_thread_show.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// renderCommunicationEntryForm renders the add-entry page with optional transient state.
func (s *Server) renderCommunicationEntryForm(w http.ResponseWriter, r *http.Request, threadID int64, extra map[string]any) {
	detail, err := s.communications.GetThreadDetail(r.Context(), threadID)
	if err != nil {
		if errors.Is(err, communications.ErrThreadNotFound) {
			http.NotFound(w, r)
			return
		}
		log.Printf("get communication thread detail for entry form: %v", err)
		http.Error(w, "could not load communication thread", http.StatusInternalServerError)
		return
	}
	data := map[string]any{
		"Title":          "Add entry",
		"ActiveNav":      "people",
		"Thread":         detail.Thread,
		"EntryDirection": "note",
	}
	for key, value := range extra {
		data[key] = value
	}
	if err := s.render(w, r, "communication_entry_new.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// renderCommunicationThreadEditForm renders the edit page with optional transient state.
func (s *Server) renderCommunicationThreadEditForm(w http.ResponseWriter, r *http.Request, threadID int64, extra map[string]any) {
	thread, err := s.communications.GetThreadByID(r.Context(), threadID)
	if err != nil {
		if errors.Is(err, communications.ErrThreadNotFound) {
			http.NotFound(w, r)
			return
		}
		log.Printf("get communication thread for edit form: %v", err)
		http.Error(w, "could not load communication thread", http.StatusInternalServerError)
		return
	}
	data := map[string]any{
		"Title":         "Edit thread",
		"ActiveNav":     "people",
		"Thread":        thread,
		"ThreadSubject": thread.Subject,
		"ThreadChannel": thread.Channel,
	}
	for key, value := range extra {
		data[key] = value
	}
	if err := s.render(w, r, "communication_thread_edit.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// updateCommunicationThreadStatus applies one allowed thread status transition.
func (s *Server) updateCommunicationThreadStatus(w http.ResponseWriter, r *http.Request, status string) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		http.NotFound(w, r)
		return
	}
	if _, err := s.communications.UpdateThreadStatus(r.Context(), id, status); err != nil {
		if errors.Is(err, communications.ErrThreadNotFound) {
			http.NotFound(w, r)
			return
		}
		if errors.Is(err, communications.ErrInvalidStatus) {
			http.Error(w, "invalid communication thread status", http.StatusBadRequest)
			return
		}
		log.Printf("update communication thread status: %v", err)
		http.Error(w, "could not update communication thread", http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, "/communication-threads/"+strconv.FormatInt(id, 10), http.StatusSeeOther)
}

// parseOccurredAt parses a datetime-local form value and falls back to the current time.
func parseOccurredAt(raw string) time.Time {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Now().UTC()
	}
	parsed, err := time.Parse("2006-01-02T15:04", raw)
	if err != nil {
		return time.Now().UTC()
	}
	return parsed.UTC()
}
