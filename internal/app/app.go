package app

import (
	"net/http"

	apphttp "github.com/ngochoang/career-planner/internal/http"
)

type App struct {
	Addr   string
	Router http.Handler
}

func New() App {
	router := apphttp.NewRouter()
	return App{
		Addr:   ":8080",
		Router: router,
	}
}