package ats

// Shared HTTP fetch helper used by the ATS-specific providers (ashby,
// greenhouse, lever). Standardizes 404 handling ("posting not found"),
// non-2xx status errors, and bounded body reads.

import (
	"errors"
	"fmt"
	"io"
	"net/http"
)

// ErrPostingNotFound is returned when the ATS API definitively signals the
// posting no longer exists (currently: HTTP 404). Callers use errors.Is on
// this sentinel to distinguish "the job is gone" from transient/format
// failures — the former should drop the URL, the latter can fall back to
// the search snippet.
var ErrPostingNotFound = errors.New("posting not found")

// fetchPostingBody executes req, applies the standard ATS status-code checks,
// and returns up to sizeLimit bytes of the response body. `kind` labels error
// messages (e.g. "greenhouse", "lever"). A nil client falls back to
// safeClient() so direct &Provider{} construction still works.
func fetchPostingBody(client *http.Client, req *http.Request, kind string, sizeLimit int64) ([]byte, error) {
	if client == nil {
		client = safeClient()
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request %s: %w", kind, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone {
		return nil, fmt.Errorf("%s: %w: %s", kind, ErrPostingNotFound, req.URL.String())
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("unexpected status %d from %s", resp.StatusCode, kind)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, sizeLimit))
	if err != nil {
		return nil, fmt.Errorf("read %s response: %w", kind, err)
	}
	return body, nil
}
