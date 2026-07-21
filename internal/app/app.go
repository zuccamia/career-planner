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
	"github.com/ngochoang/career-planner/internal/engineering_blogs"
	apphttp "github.com/ngochoang/career-planner/internal/http"
	"github.com/ngochoang/career-planner/internal/people"
	"github.com/ngochoang/career-planner/internal/sources/llm"
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
	engineeringBlogsRepo := engineering_blogs.NewSQLRepository(database)
	engineeringBlogsService := engineering_blogs.NewService(engineeringBlogsRepo)
	peopleRepo := people.NewSQLRepository(database)
	peopleService := people.NewService(peopleRepo)
	router := apphttp.NewRouter(companyService, dossierService, engineeringBlogsService, peopleService, apphttp.Options{
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
