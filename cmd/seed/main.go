package main

import (
	"context"
	"database/sql"
	_ "embed"
	"flag"
	"fmt"
	"log"
	"math/rand"
	"os"
	"time"

	appdb "github.com/zuccamia/career-planner/internal/db"
)

//go:embed samples/resume.md
var sampleResumeMarkdown string

//go:embed samples/resume.typ
var sampleResumeTypst string

type companySeed struct {
	Name        string
	Website     string
	BlogURL     string
	ATSProvider string
}

type applicationPlan struct {
	Path []string
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		log.Fatal(err)
	}
}

// run parses args and seeds the target DB. Split from main() so tests can
// invoke it with a temp DB without shelling out to `go run`.
func run(args []string) error {
	fs := flag.NewFlagSet("seed", flag.ContinueOnError)
	count := fs.Int("count", 50, "number of applications to seed")
	dbPath := fs.String("db", "web/static/local/samples/sample.sqlite", "SQLite database path to write; defaults to the checked-in sample dataset")
	// Reset defaults to true so re-running seed produces a reproducible DB
	// with -count rows. Additive runs (which historically produced a 100-row
	// sample.sqlite by accident) now require an explicit -append.
	append_ := fs.Bool("append", false, "keep existing rows and add -count more (default: wipe first)")
	seedValue := fs.Int64("seed", 42, "random seed for deterministic data generation")
	if err := fs.Parse(args); err != nil {
		return err
	}

	ctx := context.Background()
	database, err := appdb.Open(ctx, *dbPath)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer database.Close()

	if !*append_ {
		if err := resetApplicationData(ctx, database); err != nil {
			return fmt.Errorf("reset application data: %w", err)
		}
		if err := resetProfileData(ctx, database); err != nil {
			return fmt.Errorf("reset profile data: %w", err)
		}
	}

	rng := rand.New(rand.NewSource(*seedValue))
	companies := companySeeds()
	roles := roleTitles()
	plans := applicationPlans()
	now := time.Now().UTC()

	insertedApplications := 0
	insertedEvents := 0
	statusCounts := map[string]int{}

	// Pre-seed a couple of people per company so applications can reference them
	// and communication threads have somewhere to hang off.
	companyPeople := map[int64][]int64{}

	for i := 0; i < *count; i++ {
		company := companies[i%len(companies)]
		companyID, err := ensureCompany(ctx, database, company, now)
		if err != nil {
			return fmt.Errorf("ensure company %q: %w", company.Name, err)
		}

		if _, ok := companyPeople[companyID]; !ok {
			ids, err := ensurePeople(ctx, database, companyID, company, now, rng)
			if err != nil {
				return fmt.Errorf("ensure people for %q: %w", company.Name, err)
			}
			companyPeople[companyID] = ids
		}

		plan := plans[rng.Intn(len(plans))]
		role := roles[(i+rng.Intn(len(roles)))%len(roles)]
		createdAt := seededApplicationCreatedAt(now, rng)
		finalStatus := plan.Path[len(plan.Path)-1]

		var personID *int64
		if people := companyPeople[companyID]; len(people) > 0 && rng.Intn(100) < 60 {
			pid := people[rng.Intn(len(people))]
			personID = &pid
		}

		applicationID, err := createApplication(ctx, database, companyID, role, company, finalStatus, createdAt, i, personID)
		if err != nil {
			return fmt.Errorf("create application %d: %w", i+1, err)
		}
		insertedApplications++
		statusCounts[finalStatus]++

		eventsCreated, err := createStatusHistory(ctx, database, applicationID, plan.Path, createdAt, rng)
		if err != nil {
			return fmt.Errorf("create status history for application %d: %w", applicationID, err)
		}
		insertedEvents += eventsCreated
	}

	insertedThreads := 0
	insertedEntries := 0
	for _, ids := range companyPeople {
		for _, personID := range ids {
			if rng.Intn(100) >= 65 {
				continue
			}
			threadID, entryCount, err := createThreadWithEntries(ctx, database, personID, now, rng)
			if err != nil {
				return fmt.Errorf("create thread for person %d: %w", personID, err)
			}
			_ = threadID
			insertedThreads++
			insertedEntries += entryCount
		}
	}

	totalPeople := 0
	for _, ids := range companyPeople {
		totalPeople += len(ids)
	}

	profileSummary, err := seedProfile(ctx, database, now)
	if err != nil {
		return fmt.Errorf("seed profile: %w", err)
	}

	fmt.Printf("Seeded %d applications with %d status-change events\n", insertedApplications, insertedEvents)
	fmt.Printf("Seeded %d people, %d communication threads with %d entries\n", totalPeople, insertedThreads, insertedEntries)
	fmt.Printf("Seeded profile: %s\n", profileSummary)
	for _, status := range []string{"lead", "applied", "online_assessment", "first_interview", "second_interview", "additional_interview", "offer", "rejected", "ghosted", "withdrawn"} {
		if statusCounts[status] == 0 {
			continue
		}
		fmt.Printf("- %-20s %d\n", status, statusCounts[status])
	}
	return nil
}

func resetApplicationData(ctx context.Context, database *sql.DB) error {
	statements := []string{
		`DELETE FROM application_events`,
		`DELETE FROM applications`,
		`DELETE FROM communication_entries`,
		`DELETE FROM communication_threads`,
		`DELETE FROM people`,
		`DELETE FROM companies`,
		`DELETE FROM sqlite_sequence WHERE name IN ('application_events', 'applications', 'communication_entries', 'communication_threads', 'people', 'companies')`,
	}
	for _, statement := range statements {
		if _, err := database.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("exec %q: %w", statement, err)
		}
	}
	return nil
}

// resetProfileData clears the profile-related tables so re-runs of the seeder
// produce a reproducible profile section, mirroring resetApplicationData's
// contract. profile_overview has a CHECK(id=1), so this UPDATEs its columns
// back to empty rather than deleting the row.
func resetProfileData(ctx context.Context, database *sql.DB) error {
	statements := []string{
		`UPDATE profile_overview SET name='', headline='', summary='', skills_json='[]', environment='', tools_json='[]', wizard_progress=NULL, onboarded_at=NULL, updated_at=datetime('now') WHERE id=1`,
		`DELETE FROM career_sparks`,
		`DELETE FROM resumes`,
		`DELETE FROM brag_entries`,
		`DELETE FROM sqlite_sequence WHERE name IN ('career_sparks', 'resumes', 'brag_entries')`,
	}
	for _, statement := range statements {
		if _, err := database.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("exec %q: %w", statement, err)
		}
	}
	return nil
}

// seedProfile populates the Profile page — overview, ordered sparks (with
// ties so the "top-priority tier" highlight has something to lift), two
// resumes (markdown + Typst embedded from cmd/seed/samples/), and three brag
// entries. Returns a short summary line for the CLI output.
func seedProfile(ctx context.Context, database *sql.DB, now time.Time) (string, error) {
	tsFmt := now.Format("2006-01-02 15:04:05")

	const overviewSummary = "Six years shipping backend systems in high-agency teams — mostly Go and Python, " +
		"lately more infra work around ingestion and observability. Looking for a role where I can " +
		"own an end-to-end system, keep learning from strong peers, and see the impact of what I " +
		"ship in real users' hands. Remote-friendly, ideally async-first."
	const overviewSkillsJSON = `[` +
		`{"name":"Go","years":6,"level":"expert"},` +
		`{"name":"Python","years":4,"level":"advanced"},` +
		`{"name":"Data pipelines","years":5,"level":"advanced"},` +
		`{"name":"PostgreSQL","years":6,"level":"advanced"},` +
		`{"name":"Observability","years":3,"level":"intermediate"},` +
		`{"name":"Kafka","years":3,"level":"intermediate"},` +
		`{"name":"gRPC","years":4,"level":"advanced"},` +
		`{"name":"Terraform","years":2,"level":"intermediate"}` +
		`]`

	const overviewToolsJSON = `["Go","Python","gRPC","Kafka","Terraform","data pipelines","observability"]`

	if _, err := database.ExecContext(ctx, `
		UPDATE profile_overview
		SET name = ?, headline = ?, summary = ?, skills_json = ?, environment = ?, tools_json = ?, onboarded_at = ?, updated_at = ?
		WHERE id = 1`,
		"Nova Hoang", "Backend engineer, data pipelines", overviewSummary, overviewSkillsJSON,
		"remote", overviewToolsJSON, tsFmt, tsFmt,
	); err != nil {
		return "", fmt.Errorf("update profile_overview: %w", err)
	}

	sparks := []struct {
		body     string
		priority int
	}{
		{"high-agency team", 1},
		{"meaningful work", 1},
		{"fast-paced team", 1},
		{"strong technical peers", 2},
		{"learning & growth", 2},
		{"own your schedule", 3},
	}
	for _, s := range sparks {
		if _, err := database.ExecContext(ctx, `
			INSERT INTO career_sparks (body, sort_order, created_at, updated_at)
			VALUES (?, ?, ?, ?)`,
			s.body, s.priority, tsFmt, tsFmt,
		); err != nil {
			return "", fmt.Errorf("insert spark %q: %w", s.body, err)
		}
	}

	resumes := []struct {
		title, format, body string
		isPrimary           int
	}{
		{"Backend engineer resume", "md", sampleResumeMarkdown, 1},
		{"Backend engineer resume (Typst)", "typ", sampleResumeTypst, 0},
	}
	for _, r := range resumes {
		if _, err := database.ExecContext(ctx, `
			INSERT INTO resumes (title, format, body, is_primary, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?)`,
			r.title, r.format, r.body, r.isPrimary, tsFmt, tsFmt,
		); err != nil {
			return "", fmt.Errorf("insert resume %q: %w", r.title, err)
		}
	}

	brags := []struct {
		title, body, impact, tagsJSON, entryDate string
	}{
		{
			"Shipped incident-detection MVP",
			"Shipped incident-detection MVP to production behind a feature flag. " +
				"Onboarded on-call to the new dashboard.",
			"Cut mean time to detect from 22 min to under 4 min for the top 10 services.",
			`["reliability","observability","ownership"]`,
			"2025-03-12",
		},
		{
			"Rebuilt onboarding flow with legal + design",
			"Led a cross-functional rewrite of the new-user onboarding flow. " +
				"Coordinated with legal (compliance review), design (three iteration " +
				"cycles), and support (updated help docs).",
			"Reduced 30-day churn by 18%.",
			`["cross-functional","ownership","growth"]`,
			"2024-11-04",
		},
		{
			"Mentored two junior engineers through first incidents",
			"Paired with two new grads through their first Sev-2 incidents. Wrote up " +
				"an internal \"shadowing on-call\" doc that the team adopted as standard " +
				"practice for new hires.",
			"Both engineers now run on-call independently.",
			`["mentorship","process"]`,
			"2024-08-20",
		},
	}
	for _, b := range brags {
		if _, err := database.ExecContext(ctx, `
			INSERT INTO brag_entries (title, body, impact, tags_json, entry_date, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`,
			b.title, b.body, b.impact, b.tagsJSON, b.entryDate, tsFmt, tsFmt,
		); err != nil {
			return "", fmt.Errorf("insert brag %q: %w", b.title, err)
		}
	}

	return fmt.Sprintf("overview + %d sparks + %d resumes + %d brags", len(sparks), len(resumes), len(brags)), nil
}

func ensureCompany(ctx context.Context, database *sql.DB, company companySeed, now time.Time) (int64, error) {
	var id int64
	err := database.QueryRowContext(ctx, `SELECT id FROM companies WHERE official_name = ?`, company.Name).Scan(&id)
	if err == nil {
		return id, nil
	}
	if err != sql.ErrNoRows {
		return 0, err
	}
	result, err := database.ExecContext(ctx, `
		INSERT INTO companies (official_name, website, blog_url, ats_url, ats_provider, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`, company.Name, company.Website, company.BlogURL, company.Website+"/careers", company.ATSProvider, now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano))
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
}

func createApplication(ctx context.Context, database *sql.DB, companyID int64, roleTitle string, company companySeed, finalStatus string, createdAt time.Time, idx int, personID *int64) (int64, error) {
	var personArg interface{}
	if personID != nil {
		personArg = *personID
	}
	result, err := database.ExecContext(ctx, `
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
		) VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)
	`,
		companyID,
		personArg,
		roleTitle,
		fmt.Sprintf("%s/careers/%d", company.Website, idx+1),
		fmt.Sprintf("%s role at %s focused on backend systems, product collaboration, and shipping reliable features.", roleTitle, company.Name),
		finalStatus,
		fmt.Sprintf("Seeded application for %s at %s", roleTitle, company.Name),
		createdAt.Format(time.RFC3339Nano),
		createdAt.Format(time.RFC3339Nano),
	)
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
}

type personSeed struct {
	FullName string
	Title    string
}

func ensurePeople(ctx context.Context, database *sql.DB, companyID int64, company companySeed, now time.Time, rng *rand.Rand) ([]int64, error) {
	pool := personSeeds()
	// pick 2 distinct people per company from the pool
	idxA := rng.Intn(len(pool))
	idxB := (idxA + 1 + rng.Intn(len(pool)-1)) % len(pool)
	picks := []personSeed{pool[idxA], pool[idxB]}
	ids := make([]int64, 0, len(picks))
	for _, p := range picks {
		linkedin := fmt.Sprintf("https://www.linkedin.com/in/%s-%s",
			slugify(p.FullName), slugify(company.Name))
		result, err := database.ExecContext(ctx, `
			INSERT INTO people (full_name, title, company_id, social_url, notes, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`,
			p.FullName, p.Title, companyID, linkedin,
			fmt.Sprintf("Met via %s recruiting outreach.", company.Name),
			now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano),
		)
		if err != nil {
			return nil, err
		}
		id, err := result.LastInsertId()
		if err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, nil
}

func createThreadWithEntries(ctx context.Context, database *sql.DB, personID int64, now time.Time, rng *rand.Rand) (int64, int, error) {
	channels := []string{"email", "linkedin", "phone", "meeting"}
	subjects := []string{
		"Intro chat scheduling",
		"Follow-up on OA",
		"Onsite logistics",
		"Referral question",
		"Recruiter check-in",
	}
	channel := channels[rng.Intn(len(channels))]
	subject := subjects[rng.Intn(len(subjects))]
	daysAgo := rng.Intn(45)
	createdAt := now.AddDate(0, 0, -daysAgo).Add(-time.Duration(rng.Intn(24)) * time.Hour)

	// build entries first to know last activity
	entryCount := 2 + rng.Intn(3) // 2-4 entries
	entries := make([]struct {
		direction string
		content   string
		at        time.Time
	}, 0, entryCount)
	cursor := createdAt
	for i := 0; i < entryCount; i++ {
		dir := "note"
		switch i % 3 {
		case 0:
			dir = "incoming"
		case 1:
			dir = "outgoing"
		}
		entries = append(entries, struct {
			direction string
			content   string
			at        time.Time
		}{
			direction: dir,
			content:   entryContentFor(dir, subject, i),
			at:        cursor,
		})
		cursor = cursor.Add(time.Duration(4+rng.Intn(30)) * time.Hour)
	}
	lastActivity := entries[len(entries)-1].at

	result, err := database.ExecContext(ctx, `
		INSERT INTO communication_threads (
			person_id, channel, subject, status, summary,
			last_activity_at, created_at, updated_at
		) VALUES (?, ?, ?, 'open', '', ?, ?, ?)
	`,
		personID, channel, subject,
		lastActivity.Format(time.RFC3339Nano),
		createdAt.Format(time.RFC3339Nano),
		lastActivity.Format(time.RFC3339Nano),
	)
	if err != nil {
		return 0, 0, err
	}
	threadID, err := result.LastInsertId()
	if err != nil {
		return 0, 0, err
	}

	for _, e := range entries {
		if _, err := database.ExecContext(ctx, `
			INSERT INTO communication_entries (thread_id, direction, content, occurred_at, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?)
		`,
			threadID, e.direction, e.content,
			e.at.Format(time.RFC3339Nano),
			e.at.Format(time.RFC3339Nano),
			e.at.Format(time.RFC3339Nano),
		); err != nil {
			return threadID, 0, err
		}
	}
	return threadID, len(entries), nil
}

func entryContentFor(direction, subject string, idx int) string {
	switch direction {
	case "incoming":
		return fmt.Sprintf("Recruiter: quick note on %q — sharing availability and next steps.", subject)
	case "outgoing":
		return fmt.Sprintf("Me: replied re: %q, confirmed times and shared resume link.", subject)
	default:
		return fmt.Sprintf("Note %d: keeping context on %q for later follow-up.", idx+1, subject)
	}
}

func slugify(s string) string {
	out := make([]rune, 0, len(s))
	for _, r := range s {
		switch {
		case r >= 'A' && r <= 'Z':
			out = append(out, r+('a'-'A'))
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			out = append(out, r)
		case r == ' ':
			out = append(out, '-')
		}
	}
	return string(out)
}

func personSeeds() []personSeed {
	return []personSeed{
		{FullName: "Alex Chen", Title: "Technical Recruiter"},
		{FullName: "Priya Nair", Title: "Engineering Manager"},
		{FullName: "Jordan Smith", Title: "Senior Recruiter"},
		{FullName: "Maya Patel", Title: "Staff Engineer"},
		{FullName: "Ethan Brown", Title: "University Recruiter"},
		{FullName: "Sana Ali", Title: "Recruiting Coordinator"},
		{FullName: "Liam Garcia", Title: "Principal Engineer"},
		{FullName: "Noor Ibrahim", Title: "Head of Talent"},
		{FullName: "Ravi Kumar", Title: "Engineering Director"},
		{FullName: "Chloe Nguyen", Title: "Senior Recruiter"},
		{FullName: "Diego Lopez", Title: "Staff Engineer"},
		{FullName: "Hana Kim", Title: "Recruiting Partner"},
	}
}

func createStatusHistory(ctx context.Context, database *sql.DB, applicationID int64, path []string, createdAt time.Time, rng *rand.Rand) (int, error) {
	if len(path) < 2 {
		return 0, nil
	}
	lastEventAt := createdAt
	created := 0
	for i := 1; i < len(path); i++ {
		lastEventAt = lastEventAt.Add(time.Duration(2+rng.Intn(7)) * 24 * time.Hour)
		fromStatus := path[i-1]
		toStatus := path[i]
		if _, err := database.ExecContext(ctx, `
			INSERT INTO application_events (
				application_id,
				type,
				content,
				from_status,
				to_status,
				occurred_at,
				created_at,
				updated_at
			) VALUES (?, 'status_changed', ?, ?, ?, ?, ?, ?)
		`, applicationID, transitionNote(fromStatus, toStatus), fromStatus, toStatus, lastEventAt.Format(time.RFC3339Nano), lastEventAt.Format(time.RFC3339Nano), lastEventAt.Format(time.RFC3339Nano)); err != nil {
			return created, err
		}
		created++
	}
	_, err := database.ExecContext(ctx, `UPDATE applications SET updated_at = ?, status = ? WHERE id = ?`, lastEventAt.Format(time.RFC3339Nano), path[len(path)-1], applicationID)
	if err != nil {
		return created, err
	}
	return created, nil
}

func seededApplicationCreatedAt(now time.Time, rng *rand.Rand) time.Time {
	daysAgo := 0
	if rng.Intn(100) < 80 {
		daysAgo = rng.Intn(30)
	} else {
		daysAgo = 30 + rng.Intn(61)
	}

	hourOffset := time.Duration(rng.Intn(18)) * time.Hour
	minuteOffset := time.Duration(rng.Intn(60)) * time.Minute
	return now.AddDate(0, 0, -daysAgo).Add(-hourOffset).Add(-minuteOffset)
}

func transitionNote(fromStatus, toStatus string) string {
	return fmt.Sprintf("Moved from %s to %s after a realistic recruiting step.", fromStatus, toStatus)
}

func companySeeds() []companySeed {
	return []companySeed{
		{Name: "Stripe", Website: "https://stripe.com", BlogURL: "https://stripe.com/blog/engineering", ATSProvider: "greenhouse"},
		{Name: "Notion", Website: "https://www.notion.so", BlogURL: "https://www.notion.so/blog/topic/engineering", ATSProvider: "ashby"},
		{Name: "Figma", Website: "https://www.figma.com", BlogURL: "https://www.figma.com/blog/engineering", ATSProvider: "greenhouse"},
		{Name: "Datadog", Website: "https://www.datadoghq.com", BlogURL: "https://www.datadoghq.com/blog/engineering", ATSProvider: "greenhouse"},
		{Name: "Cloudflare", Website: "https://www.cloudflare.com", BlogURL: "https://blog.cloudflare.com", ATSProvider: "greenhouse"},
		{Name: "Canva", Website: "https://www.canva.com", BlogURL: "https://www.canva.dev/blog/engineering", ATSProvider: "greenhouse"},
		{Name: "Linear", Website: "https://linear.app", BlogURL: "https://linear.app/blog", ATSProvider: "ashby"},
		{Name: "Vercel", Website: "https://vercel.com", BlogURL: "https://vercel.com/blog", ATSProvider: "greenhouse"},
		{Name: "Dropbox", Website: "https://www.dropbox.com", BlogURL: "https://dropbox.tech", ATSProvider: "greenhouse"},
		{Name: "Shopify", Website: "https://www.shopify.com", BlogURL: "https://shopify.engineering", ATSProvider: "greenhouse"},
		{Name: "Ramp", Website: "https://ramp.com", BlogURL: "https://engineering.ramp.com", ATSProvider: "ashby"},
		{Name: "Plaid", Website: "https://plaid.com", BlogURL: "https://plaid.com/blog/engineering", ATSProvider: "greenhouse"},
	}
}

func roleTitles() []string {
	return []string{
		"Software Engineer Intern",
		"Backend Engineer",
		"Frontend Engineer",
		"Full Stack Engineer",
		"Platform Engineer",
		"Product Engineer",
		"Infrastructure Engineer",
		"Data Engineer",
	}
}

func applicationPlans() []applicationPlan {
	return []applicationPlan{
		{Path: []string{"lead"}},
		{Path: []string{"lead", "applied"}},
		{Path: []string{"lead", "applied", "online_assessment"}},
		{Path: []string{"lead", "applied", "online_assessment", "first_interview"}},
		{Path: []string{"lead", "applied", "online_assessment", "first_interview", "second_interview"}},
		{Path: []string{"lead", "applied", "online_assessment", "first_interview", "second_interview", "additional_interview"}},
		{Path: []string{"lead", "applied", "online_assessment", "first_interview", "second_interview", "offer"}},
		{Path: []string{"lead", "applied", "rejected"}},
		{Path: []string{"lead", "applied", "online_assessment", "rejected"}},
		{Path: []string{"lead", "applied", "online_assessment", "first_interview", "rejected"}},
		{Path: []string{"lead", "applied", "withdrawn"}},
		{Path: []string{"lead", "applied", "online_assessment", "first_interview", "withdrawn"}},
		{Path: []string{"lead", "applied", "ghosted"}},
		{Path: []string{"lead", "applied", "online_assessment", "ghosted"}},
		{Path: []string{"lead", "applied", "online_assessment", "first_interview", "ghosted"}},
	}
}
