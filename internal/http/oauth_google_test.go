package http

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func decodeJSON(t *testing.T, r io.Reader) map[string]string {
	t.Helper()
	var out map[string]string
	if err := json.NewDecoder(r).Decode(&out); err != nil {
		t.Fatalf("decode json: %v", err)
	}
	return out
}

// ---------- googleOAuthConfig ----------

func TestGoogleOAuthConfigMissingClientID(t *testing.T) {
	t.Setenv("GOOGLE_OAUTH_CLIENT_ID", "")
	w := httptest.NewRecorder()
	(&Server{}).googleOAuthConfig(w, httptest.NewRequest("GET", "/oauth/google/config", nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusServiceUnavailable)
	}
}

func TestGoogleOAuthConfigDefaultsScopes(t *testing.T) {
	t.Setenv("GOOGLE_OAUTH_CLIENT_ID", "abc.apps.googleusercontent.com")
	t.Setenv("GOOGLE_OAUTH_SCOPES", "")
	w := httptest.NewRecorder()
	(&Server{}).googleOAuthConfig(w, httptest.NewRequest("GET", "/oauth/google/config", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	body := decodeJSON(t, w.Body)
	if body["client_id"] != "abc.apps.googleusercontent.com" {
		t.Errorf("client_id = %q", body["client_id"])
	}
	if body["scopes"] != defaultGoogleOAuthScopes {
		t.Errorf("scopes = %q, want default", body["scopes"])
	}
}

func TestGoogleOAuthConfigCustomScopes(t *testing.T) {
	t.Setenv("GOOGLE_OAUTH_CLIENT_ID", "abc")
	t.Setenv("GOOGLE_OAUTH_SCOPES", "https://www.googleapis.com/auth/drive")
	w := httptest.NewRecorder()
	(&Server{}).googleOAuthConfig(w, httptest.NewRequest("GET", "/oauth/google/config", nil))
	body := decodeJSON(t, w.Body)
	if body["scopes"] != "https://www.googleapis.com/auth/drive" {
		t.Errorf("scopes = %q, want custom override", body["scopes"])
	}
}

// ---------- googleTokenExchange ----------

// fakeGoogle stands in for Google's token endpoint. Captures the form the
// handler forwards; returns the given status/body verbatim.
func fakeGoogle(t *testing.T, status int, body string) (*httptest.Server, *url.Values) {
	t.Helper()
	captured := &url.Values{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("parse form: %v", err)
		}
		*captured = r.PostForm
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	prev := googleTokenURL
	googleTokenURL = srv.URL
	t.Cleanup(func() {
		googleTokenURL = prev
		srv.Close()
	})
	return srv, captured
}

func TestGoogleTokenExchangeMissingEnv(t *testing.T) {
	t.Setenv("GOOGLE_OAUTH_CLIENT_ID", "")
	t.Setenv("GOOGLE_OAUTH_CLIENT_SECRET", "")
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/oauth/google/token",
		strings.NewReader(`{"grant_type":"authorization_code"}`))
	(&Server{}).googleTokenExchange(w, r)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", w.Code)
	}
}

func TestGoogleTokenExchangeInvalidJSON(t *testing.T) {
	t.Setenv("GOOGLE_OAUTH_CLIENT_ID", "abc")
	t.Setenv("GOOGLE_OAUTH_CLIENT_SECRET", "sec")
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/oauth/google/token", strings.NewReader("{not json"))
	(&Server{}).googleTokenExchange(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestGoogleTokenExchangeBadGrantType(t *testing.T) {
	t.Setenv("GOOGLE_OAUTH_CLIENT_ID", "abc")
	t.Setenv("GOOGLE_OAUTH_CLIENT_SECRET", "sec")
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/oauth/google/token",
		strings.NewReader(`{"grant_type":"password"}`))
	(&Server{}).googleTokenExchange(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestGoogleTokenExchangeAuthorizationCodeForwardsCredentialsAndPayload(t *testing.T) {
	t.Setenv("GOOGLE_OAUTH_CLIENT_ID", "abc")
	t.Setenv("GOOGLE_OAUTH_CLIENT_SECRET", "sec")
	_, sent := fakeGoogle(t, http.StatusOK,
		`{"access_token":"tok","refresh_token":"ref","expires_in":3600}`)

	w := httptest.NewRecorder()
	body := `{"grant_type":"authorization_code","code":"c","code_verifier":"v","redirect_uri":"http://x/cb"}`
	r := httptest.NewRequest("POST", "/oauth/google/token", strings.NewReader(body))
	(&Server{}).googleTokenExchange(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if sent.Get("client_id") != "abc" || sent.Get("client_secret") != "sec" {
		t.Errorf("credentials not forwarded: %v", *sent)
	}
	if sent.Get("grant_type") != "authorization_code" {
		t.Errorf("grant_type = %q", sent.Get("grant_type"))
	}
	for k, want := range map[string]string{"code": "c", "code_verifier": "v", "redirect_uri": "http://x/cb"} {
		if sent.Get(k) != want {
			t.Errorf("%s = %q, want %q", k, sent.Get(k), want)
		}
	}
	if !strings.Contains(w.Body.String(), `"access_token":"tok"`) {
		t.Errorf("body not passed through: %q", w.Body.String())
	}
}

func TestGoogleTokenExchangeRefreshTokenForwardsRefreshOnly(t *testing.T) {
	t.Setenv("GOOGLE_OAUTH_CLIENT_ID", "abc")
	t.Setenv("GOOGLE_OAUTH_CLIENT_SECRET", "sec")
	_, sent := fakeGoogle(t, http.StatusOK, `{"access_token":"tok2","expires_in":3600}`)

	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/oauth/google/token",
		strings.NewReader(`{"grant_type":"refresh_token","refresh_token":"r"}`))
	(&Server{}).googleTokenExchange(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if sent.Get("grant_type") != "refresh_token" {
		t.Errorf("grant_type = %q", sent.Get("grant_type"))
	}
	if sent.Get("refresh_token") != "r" {
		t.Errorf("refresh_token = %q", sent.Get("refresh_token"))
	}
	if sent.Get("code") != "" || sent.Get("code_verifier") != "" || sent.Get("redirect_uri") != "" {
		t.Errorf("auth-code fields leaked into refresh flow: %v", *sent)
	}
}

func TestGoogleTokenExchangePassesThroughUpstreamErrorStatus(t *testing.T) {
	t.Setenv("GOOGLE_OAUTH_CLIENT_ID", "abc")
	t.Setenv("GOOGLE_OAUTH_CLIENT_SECRET", "sec")
	fakeGoogle(t, http.StatusBadRequest, `{"error":"invalid_grant"}`)

	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/oauth/google/token",
		strings.NewReader(`{"grant_type":"authorization_code","code":"bad"}`))
	(&Server{}).googleTokenExchange(w, r)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 passthrough", w.Code)
	}
	if !strings.Contains(w.Body.String(), "invalid_grant") {
		t.Errorf("upstream error body not forwarded: %q", w.Body.String())
	}
}
