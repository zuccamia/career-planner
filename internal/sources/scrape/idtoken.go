package scrape

// Google-signed ID token fetcher for calling private Cloud Run services.
// Cloud Run accepts an ID token in `X-Serverless-Authorization` (in addition
// to the standard `Authorization` header) specifically for scenarios like
// ours where the target service uses `Authorization: Bearer <app-token>` for
// its own app-level auth and can't share the header with Google's IAM check.
// Docs: https://cloud.google.com/run/docs/authenticating/service-to-service
//
// Off-GCP (local dev, CI) the metadata server is unreachable — get() returns
// an error quickly and the caller proceeds without the header. This lets a
// self-hosted crawl4ai on localhost keep working unchanged.

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

// metadataIdentityURL is the GCE metadata server endpoint that mints an
// audience-scoped ID token for the current instance's service account.
// Overridable in tests via a shim.
var metadataIdentityURL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity"

// idTokenTTL is how long we reuse a cached token before refetching. Google ID
// tokens expire after 60min; 45min leaves a safe margin.
const idTokenTTL = 45 * time.Minute

// idTokenFetcher lazily fetches and caches a Google ID token targeted at a
// specific audience (a Cloud Run service URL). Safe for concurrent use.
type idTokenFetcher struct {
	audience string
	http     *http.Client

	mu      sync.Mutex
	token   string
	fetched time.Time
}

func newIDTokenFetcher(audience string) *idTokenFetcher {
	return &idTokenFetcher{
		audience: audience,
		// Tight timeout: on-GCP the metadata server responds in milliseconds;
		// off-GCP we want to fail fast so the caller can skip the header
		// without stalling the whole request.
		http: &http.Client{Timeout: 2 * time.Second},
	}
}

func (f *idTokenFetcher) get(ctx context.Context) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.token != "" && time.Since(f.fetched) < idTokenTTL {
		return f.token, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		metadataIdentityURL+"?audience="+url.QueryEscape(f.audience), nil)
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

// isCloudRunURL is the heuristic that decides whether to bother trying to
// mint an ID token. Cloud Run production URLs end in `.run.app` (covers both
// old-style `*.a.run.app` and new-style `*.<region>.run.app`). We keep the
// check narrow so calls to third-party scrapers (firecrawl.dev, self-hosted
// crawl4ai) don't leak audience-scoped tokens. Case-normalized and
// port-stripped so weird-but-legal URL forms still classify correctly.
// Custom domains mapped to Cloud Run are NOT auto-detected — if you point
// SCRAPER_BASE_URL at api.example.com backed by Cloud Run, ID tokens won't
// be sent, so use `--allow-unauthenticated` in that case.
func isCloudRunURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	return strings.HasSuffix(strings.ToLower(u.Hostname()), ".run.app")
}
