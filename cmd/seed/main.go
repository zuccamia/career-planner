package main

import (
	"context"
	"database/sql"
	"flag"
	"fmt"
	"log"
	"math/rand"
	"time"

	appdb "github.com/ngochoang/career-planner/internal/db"
)

type companySeed struct {
	Name        string
	Website     string
	TechBlogURL string
	ATSProvider string
}

type applicationPlan struct {
	Path []string
}

func main() {
	count := flag.Int("count", 50, "number of applications to seed")
	dbPath := flag.String("db", "", "SQLite database path (defaults to DATABASE_PATH or career-planner.sqlite3)")
	reset := flag.Bool("reset", false, "delete existing companies/applications/application events before seeding")
	seedValue := flag.Int64("seed", 42, "random seed for deterministic data generation")
	flag.Parse()

	ctx := context.Background()
	database, err := appdb.Open(ctx, *dbPath)
	if err != nil {
		log.Fatalf("open database: %v", err)
	}
	defer database.Close()

	if *reset {
		if err := resetApplicationData(ctx, database); err != nil {
			log.Fatalf("reset application data: %v", err)
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

	for i := 0; i < *count; i++ {
		company := companies[i%len(companies)]
		companyID, err := ensureCompany(ctx, database, company, now)
		if err != nil {
			log.Fatalf("ensure company %q: %v", company.Name, err)
		}

		plan := plans[rng.Intn(len(plans))]
		role := roles[(i+rng.Intn(len(roles)))%len(roles)]
		createdAt := seededApplicationCreatedAt(now, rng)
		finalStatus := plan.Path[len(plan.Path)-1]

		applicationID, err := createApplication(ctx, database, companyID, role, company, finalStatus, createdAt, i)
		if err != nil {
			log.Fatalf("create application %d: %v", i+1, err)
		}
		insertedApplications++
		statusCounts[finalStatus]++

		eventsCreated, err := createStatusHistory(ctx, database, applicationID, plan.Path, createdAt, rng)
		if err != nil {
			log.Fatalf("create status history for application %d: %v", applicationID, err)
		}
		insertedEvents += eventsCreated
	}

	fmt.Printf("Seeded %d applications with %d status-change events\n", insertedApplications, insertedEvents)
	for _, status := range []string{"wishlist", "applied", "online_assessment", "first_interview", "second_interview", "additional_interview", "offer", "rejected", "withdrawn"} {
		if statusCounts[status] == 0 {
			continue
		}
		fmt.Printf("- %-20s %d\n", status, statusCounts[status])
	}
}

func resetApplicationData(ctx context.Context, database *sql.DB) error {
	statements := []string{
		`DELETE FROM application_artifacts`,
		`DELETE FROM application_events`,
		`DELETE FROM applications`,
		`DELETE FROM communication_entries`,
		`DELETE FROM communication_threads`,
		`DELETE FROM engineering_blog_notes`,
		`DELETE FROM people`,
		`DELETE FROM dossiers`,
		`DELETE FROM companies`,
		`DELETE FROM sqlite_sequence WHERE name IN ('application_artifacts', 'application_events', 'applications', 'communication_entries', 'communication_threads', 'engineering_blog_notes', 'people', 'dossiers', 'companies')`,
	}
	for _, statement := range statements {
		if _, err := database.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("exec %q: %w", statement, err)
		}
	}
	return nil
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
		INSERT INTO companies (official_name, website, tech_blog_url, ats_url, ats_provider, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`, company.Name, company.Website, company.TechBlogURL, company.Website+"/careers", company.ATSProvider, now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano))
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
}

func createApplication(ctx context.Context, database *sql.DB, companyID int64, roleTitle string, company companySeed, finalStatus string, createdAt time.Time, idx int) (int64, error) {
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
		) VALUES (?, NULL, ?, ?, ?, '{}', ?, ?, ?, ?)
	`,
		companyID,
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
		{Name: "Stripe", Website: "https://stripe.com", TechBlogURL: "https://stripe.com/blog/engineering", ATSProvider: "greenhouse"},
		{Name: "Notion", Website: "https://www.notion.so", TechBlogURL: "https://www.notion.so/blog/topic/engineering", ATSProvider: "ashby"},
		{Name: "Figma", Website: "https://www.figma.com", TechBlogURL: "https://www.figma.com/blog/engineering", ATSProvider: "greenhouse"},
		{Name: "Datadog", Website: "https://www.datadoghq.com", TechBlogURL: "https://www.datadoghq.com/blog/engineering", ATSProvider: "greenhouse"},
		{Name: "Cloudflare", Website: "https://www.cloudflare.com", TechBlogURL: "https://blog.cloudflare.com", ATSProvider: "greenhouse"},
		{Name: "Canva", Website: "https://www.canva.com", TechBlogURL: "https://www.canva.dev/blog/engineering", ATSProvider: "greenhouse"},
		{Name: "Linear", Website: "https://linear.app", TechBlogURL: "https://linear.app/blog", ATSProvider: "ashby"},
		{Name: "Vercel", Website: "https://vercel.com", TechBlogURL: "https://vercel.com/blog", ATSProvider: "greenhouse"},
		{Name: "Dropbox", Website: "https://www.dropbox.com", TechBlogURL: "https://dropbox.tech", ATSProvider: "greenhouse"},
		{Name: "Shopify", Website: "https://www.shopify.com", TechBlogURL: "https://shopify.engineering", ATSProvider: "greenhouse"},
		{Name: "Ramp", Website: "https://ramp.com", TechBlogURL: "https://engineering.ramp.com", ATSProvider: "ashby"},
		{Name: "Plaid", Website: "https://plaid.com", TechBlogURL: "https://plaid.com/blog/engineering", ATSProvider: "greenhouse"},
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
		{Path: []string{"wishlist"}},
		{Path: []string{"wishlist", "applied"}},
		{Path: []string{"wishlist", "applied", "online_assessment"}},
		{Path: []string{"wishlist", "applied", "online_assessment", "first_interview"}},
		{Path: []string{"wishlist", "applied", "online_assessment", "first_interview", "second_interview"}},
		{Path: []string{"wishlist", "applied", "online_assessment", "first_interview", "second_interview", "additional_interview"}},
		{Path: []string{"wishlist", "applied", "online_assessment", "first_interview", "second_interview", "offer"}},
		{Path: []string{"wishlist", "applied", "rejected"}},
		{Path: []string{"wishlist", "applied", "online_assessment", "rejected"}},
		{Path: []string{"wishlist", "applied", "online_assessment", "first_interview", "rejected"}},
		{Path: []string{"wishlist", "applied", "withdrawn"}},
		{Path: []string{"wishlist", "applied", "online_assessment", "first_interview", "withdrawn"}},
	}
}
