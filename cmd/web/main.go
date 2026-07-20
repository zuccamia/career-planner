package main

import (
	"log"
	"net/http"

	"github.com/ngochoang/career-planner/internal/app"
)

func main() {
	application := app.New()

	log.Printf("starting web server on %s", application.Addr)
	if err := http.ListenAndServe(application.Addr, application.Router); err != nil {
		log.Fatal(err)
	}
}