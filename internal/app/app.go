package app

import (
	"context"
	"database/sql"
	"net/http"
	"os"

	"github.com/ngochoang/career-planner/internal/companies"
	"github.com/ngochoang/career-planner/internal/db"
	"github.com/ngochoang/career-planner/internal/dossiers"
	"github.com/ngochoang/career-planner/internal/engineeringnotes"
	apphttp "github.com/ngochoang/career-planner/internal/http"
	"github.com/ngochoang/career-planner/internal/llm"
	"github.com/ngochoang/career-planner/internal/people"
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
	engineeringNotesRepo := engineeringnotes.NewSQLRepository(database)
	engineeringNotesService := engineeringnotes.NewService(engineeringNotesRepo)
	peopleRepo := people.NewSQLRepository(database)
	peopleService := people.NewService(peopleRepo)
	router := apphttp.NewRouter(companyService, dossierService, engineeringNotesService, peopleService)
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
