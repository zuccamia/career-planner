package http

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
)

// googleTokenExchange proxies Google's OAuth token endpoint so that the
// client_secret stays server-side rather than shipping in the browser.
// The browser POSTs JSON like {"grant_type":"authorization_code","code":"...",
// "code_verifier":"...","redirect_uri":"..."} or {"grant_type":"refresh_token",
// "refresh_token":"..."}. The server adds client_id + client_secret from env
// and forwards to Google, returning Google's JSON response verbatim.
func (s *Server) googleTokenExchange(w http.ResponseWriter, r *http.Request) {
	clientID := strings.TrimSpace(os.Getenv("GOOGLE_OAUTH_CLIENT_ID"))
	clientSecret := strings.TrimSpace(os.Getenv("GOOGLE_OAUTH_CLIENT_SECRET"))
	if clientID == "" || clientSecret == "" {
		http.Error(w, "GOOGLE_OAUTH_CLIENT_ID or GOOGLE_OAUTH_CLIENT_SECRET not configured", http.StatusServiceUnavailable)
		return
	}

	var body map[string]string
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, fmt.Sprintf("invalid json: %v", err), http.StatusBadRequest)
		return
	}
	grantType := body["grant_type"]
	if grantType != "authorization_code" && grantType != "refresh_token" {
		http.Error(w, "grant_type must be authorization_code or refresh_token", http.StatusBadRequest)
		return
	}

	form := url.Values{}
	form.Set("client_id", clientID)
	form.Set("client_secret", clientSecret)
	form.Set("grant_type", grantType)
	switch grantType {
	case "authorization_code":
		for _, k := range []string{"code", "code_verifier", "redirect_uri"} {
			if v := body[k]; v != "" {
				form.Set(k, v)
			}
		}
	case "refresh_token":
		if v := body["refresh_token"]; v != "" {
			form.Set("refresh_token", v)
		}
	}

	req, err := http.NewRequestWithContext(r.Context(), "POST", "https://oauth2.googleapis.com/token", strings.NewReader(form.Encode()))
	if err != nil {
		http.Error(w, fmt.Sprintf("build request: %v", err), http.StatusInternalServerError)
		return
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		http.Error(w, fmt.Sprintf("google token endpoint: %v", err), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Pass Google's response through verbatim (status + body).
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}
