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

// defaultGoogleOAuthScopes is what the browser gets when GOOGLE_OAUTH_SCOPES
// isn't overridden. drive.appdata holds hidden snapshots; drive.file limits
// attachment access to files the app creates.
const defaultGoogleOAuthScopes = "https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file"

// googleTokenURL is Google's OAuth token endpoint. Exposed as a package
// variable so tests can point it at an httptest.Server.
var googleTokenURL = "https://oauth2.googleapis.com/token"

// googleOAuthConfig returns the browser-safe OAuth config from the same env
// vars the token-exchange handler uses, so browser and server stay in sync
// without hardcoding values in the JS bundle. Neither the client ID nor the
// scope string is a secret (both are visible in the OAuth redirect URL) —
// this is config hygiene, not a security boundary.
func (s *Server) googleOAuthConfig(w http.ResponseWriter, r *http.Request) {
	clientID := strings.TrimSpace(os.Getenv("GOOGLE_OAUTH_CLIENT_ID"))
	if clientID == "" {
		http.Error(w, "GOOGLE_OAUTH_CLIENT_ID not configured", http.StatusServiceUnavailable)
		return
	}
	scopes := strings.TrimSpace(os.Getenv("GOOGLE_OAUTH_SCOPES"))
	if scopes == "" {
		scopes = defaultGoogleOAuthScopes
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"client_id": clientID,
		"scopes":    scopes,
	})
}

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

	req, err := http.NewRequestWithContext(r.Context(), "POST", googleTokenURL, strings.NewReader(form.Encode()))
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
