// Package gcp holds helpers for calling private GCP services. Fetcher reads
// audience-scoped ID tokens from the GCE metadata server; callers attach the
// token in X-Serverless-Authorization so Cloud Run IAM passes without
// touching the standard Authorization header. Off-GCP, Get errors fast so
// callers can drop the header and continue against a localhost target.
package gcp

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// MetadataIdentityURL is overridable so tests can point at an httptest server.
var MetadataIdentityURL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity"

// Tokens expire after 60 min; 45 leaves a safe margin.
const idTokenTTL = 45 * time.Minute

// Fetcher caches an ID token for one audience. Safe for concurrent use.
type Fetcher struct {
	audience string
	http     *http.Client

	mu      sync.Mutex
	token   string
	fetched time.Time
}

func NewFetcher(audience string) *Fetcher {
	return &Fetcher{
		audience: audience,
		// Tight timeout: off-GCP callers should fail fast and drop the header.
		http: &http.Client{Timeout: 2 * time.Second},
	}
}

func (f *Fetcher) Get(ctx context.Context) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.token != "" && time.Since(f.fetched) < idTokenTTL {
		return f.token, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		MetadataIdentityURL+"?audience="+url.QueryEscape(f.audience), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Metadata-Flavor", "Google")
	resp, err := f.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("metadata server %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	f.token = strings.TrimSpace(string(body))
	f.fetched = time.Now()
	return f.token, nil
}

// IsRunAppURL reports whether raw points at a *.run.app host. Custom domains
// mapped to Cloud Run are NOT detected — deploy those --allow-unauthenticated.
func IsRunAppURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	return strings.HasSuffix(strings.ToLower(u.Hostname()), ".run.app")
}
