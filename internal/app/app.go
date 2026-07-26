package app

import (
	"net/http"
	"os"
	"strings"

	"github.com/zuccamia/career-planner/internal/applications"
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

	llmClient := newLLMClient()
	router := apphttp.NewRouter(
		companies.NewService(llmClient),
		dossiers.NewService(llmClient),
		applications.NewService(llmClient),
		communications.NewService(llmClient),
	)
	return App{Addr: addr, Router: router}
}

func newLLMClient() llm.Client {
	config, err := llm.LoadConfig()
	if err != nil {
		return nil
	}
	return llm.NewClient(config)
}
