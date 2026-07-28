package app

import (
	"net/http"
	"os"
	"strings"

	"github.com/zuccamia/career-planner/internal/applications"
	"github.com/zuccamia/career-planner/internal/brags"
	"github.com/zuccamia/career-planner/internal/communications"
	"github.com/zuccamia/career-planner/internal/companies"
	"github.com/zuccamia/career-planner/internal/dossiers"
	apphttp "github.com/zuccamia/career-planner/internal/http"
	"github.com/zuccamia/career-planner/internal/sources/llm"
)

type App struct {
	Addr   string
	Router http.Handler
}

// New wires the HTTP server for the local-first application. The server holds
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

	llmClient, serverLLM := newLLMClient()
	router := apphttp.NewRouter(
		companies.NewService(llmClient),
		dossiers.NewService(llmClient),
		applications.NewService(llmClient),
		brags.NewService(llmClient),
		communications.NewService(llmClient),
		serverLLM,
	)
	return App{Addr: addr, Router: router}
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
