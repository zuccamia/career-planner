package app

import (
	"context"
	"database/sql"
	"net/http"
	"os"

	"github.com/ngochoang/career-planner/internal/companies"
	"github.com/ngochoang/career-planner/internal/db"
	"github.com/ngochoang/career-planner/internal/dossiers"
	apphttp "github.com/ngochoang/career-planner/internal/http"
	"github.com/ngochoang/career-planner/internal/llm"
)

type App struct {
	Addr   string
	Router http.Handler
	DB     *sql.DB
}

func New() App {
	ctx := context.Background()
	database, err := db.Open(ctx, os.Getenv("DATABASE_PATH"))
	if err != nil {
		panic(err)
	}

	companyRepo := companies.NewSQLRepository(database)
	llmClient := newLLMClient()
	companyService := companies.NewService(llmClient, companyRepo)
	dossierRepo := dossiers.NewSQLRepository(database)
	dossierService := dossiers.NewService(llmClient, dossierRepo)
	router := apphttp.NewRouter(companyService, dossierService)
	return App{
		Addr:   ":8080",
		Router: router,
		DB:     database,
	}
}

func newLLMClient() llm.Client {
	config, err := llm.LoadConfig()
	if err != nil {
		return nil
	}
	return llm.NewClient(config)
}
