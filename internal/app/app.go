package app

import (
	"context"
	"database/sql"
	"net/http"
	"os"
	"strings"

	"github.com/ngochoang/career-planner/internal/companies"
	"github.com/ngochoang/career-planner/internal/db"
	"github.com/ngochoang/career-planner/internal/dossiers"
	"github.com/ngochoang/career-planner/internal/engineeringnotes"
	apphttp "github.com/ngochoang/career-planner/internal/http"
	"github.com/ngochoang/career-planner/internal/llm"
	"github.com/ngochoang/career-planner/internal/people"
)

type App struct {
	Addr        string
	Router      http.Handler
	DB          *sql.DB
	DBPath      string
	Environment string
}

func New() App {
	ctx := context.Background()
	databasePath := os.Getenv("DATABASE_PATH")
	resolvedPath, err := db.ResolvePath(databasePath)
	if err != nil {
		panic(err)
	}
	database, err := db.Open(ctx, databasePath)
	if err != nil {
		panic(err)
	}

	addr := strings.TrimSpace(os.Getenv("APP_ADDR"))
	if addr == "" {
		addr = ":8080"
	}
	environment := strings.TrimSpace(os.Getenv("APP_ENV"))

	companyRepo := companies.NewSQLRepository(database)
	llmClient := newLLMClient()
	companyService := companies.NewService(llmClient, companyRepo)
	dossierRepo := dossiers.NewSQLRepository(database)
	dossierService := dossiers.NewService(llmClient, dossierRepo)
	engineeringNotesRepo := engineeringnotes.NewSQLRepository(database)
	engineeringNotesService := engineeringnotes.NewService(engineeringNotesRepo)
	peopleRepo := people.NewSQLRepository(database)
	peopleService := people.NewService(peopleRepo)
	router := apphttp.NewRouter(companyService, dossierService, engineeringNotesService, peopleService, apphttp.Options{
		Environment:  environment,
		DatabasePath: resolvedPath,
	})
	return App{
		Addr:        addr,
		Router:      router,
		DB:          database,
		DBPath:      resolvedPath,
		Environment: environment,
	}
}

func newLLMClient() llm.Client {
	config, err := llm.LoadConfig()
	if err != nil {
		return nil
	}
	return llm.NewClient(config)
}
