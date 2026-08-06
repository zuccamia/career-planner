package app

import (
	"context"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/zuccamia/career-planner/internal/applications"
	"github.com/zuccamia/career-planner/internal/brags"
	"github.com/zuccamia/career-planner/internal/communications"
	"github.com/zuccamia/career-planner/internal/profile"
	"github.com/zuccamia/career-planner/internal/companies"
	"github.com/zuccamia/career-planner/internal/dossiers"
	apphttp "github.com/zuccamia/career-planner/internal/http"
	"github.com/zuccamia/career-planner/internal/i18n"
	"github.com/zuccamia/career-planner/internal/sources/ats"
	"github.com/zuccamia/career-planner/internal/sources/llm"
	"github.com/zuccamia/career-planner/internal/sources/scrape"
)

type App struct {
	Addr   string
	Router http.Handler
}

// New wires the HTTP server for the application. The server holds
// no persistent data — the browser owns SQLite via OPFS.
func New() App {
	addr := strings.TrimSpace(os.Getenv("APP_ADDR"))
	if addr == "" {
		if port := strings.TrimSpace(os.Getenv("PORT")); port != "" {
			addr = ":" + port
		} else {
			addr = ":8080"
		}
	}

	if err := i18n.Load(); err != nil {
		log.Fatalf("i18n: %v", err)
	}

	llmClient, serverLLM := newLLMClient()
	scrapeClient, serverScrape := newScrapeClient()

	// ATS registry: ATS-specific providers first, plain-HTTP Generic fallback
	// last. When a server-side scraper is configured, applications.Service
	// prefers it over Generic for unknown-host URLs (see its routing switch)
	// — it isn't plugged in here.
	atsRegistry := ats.NewRegistry(ats.NewGeneric(), ats.NewGreenhouse(), ats.NewLever(), ats.NewAshby())

	router := apphttp.NewRouter(
		companies.NewService(llmClient),
		dossiers.NewService(llmClient),
		applications.NewService(llmClient, atsRegistry.Fetch, atsRegistry.HasSupportingProvider, newMarkdownScraper(scrapeClient)),
		brags.NewService(llmClient),
		communications.NewService(llmClient),
		profile.NewService(llmClient),
		serverLLM,
		serverScrape,
		scrapeClient,
	)
	return App{Addr: addr, Router: router}
}

// newMarkdownScraper adapts a scrape.Client into the small (ctx, url) → md
// function applications.Service expects. Returns nil when the client is nil so
// the service's routing switch skips the "unknown host + scraper" branch and
// falls through to the registry's Generic fallback.
func newMarkdownScraper(client scrape.Client) func(ctx context.Context, url string) (string, error) {
	if client == nil {
		return nil
	}
	return func(ctx context.Context, url string) (string, error) {
		res, err := client.Scrape(ctx, url, scrape.ScrapeOptions{
			Formats: []string{"markdown"}, OnlyMainContent: true,
		})
		if err != nil {
			return "", err
		}
		return res.Markdown, nil
	}
}

// newLLMClient loads the server-side LLM config from env vars. Missing/invalid
// config is not fatal — the server boots BYOK-only and advertises the
// server-side LLM as unavailable via /api/llm/server-status.
func newLLMClient() (llm.Client, apphttp.ServerLLM) {
	config, err := llm.LoadConfig()
	if err != nil {
		return nil, apphttp.ServerLLM{}
	}
	return llm.NewClient(config), apphttp.ServerLLM{
		Available: true,
		Provider:  config.Provider,
		Model:     config.Model,
	}
}

// newScrapeClient loads the server-side scraper config from env vars. Missing/
// invalid config is not fatal — dossier enrichment and JD fallback keep
// working via today's non-scraped paths, and browser BYOK scraping remains
// available regardless of server config.
func newScrapeClient() (scrape.Client, apphttp.ServerScrape) {
	config, err := scrape.LoadConfig()
	if err != nil {
		return nil, apphttp.ServerScrape{}
	}
	client, err := scrape.NewClient(config)
	if err != nil {
		log.Printf("scrape: disabled: %v", err)
		return nil, apphttp.ServerScrape{}
	}
	return client, apphttp.ServerScrape{
		Available: true,
		Backend:   config.Backend,
	}
}
