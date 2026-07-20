package http

// Applies shared request handling behavior across routes.

import (
	"log"
	"net/http"
)

// logging logs the request method and path before passing control to the next handler.
func logging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Printf("%s %s", r.Method, r.URL.Path)
		next.ServeHTTP(w, r)
	})
}
