package providers

// Shared HTTP fetch helper used by the ATS-specific providers (ashby,
// greenhouse, lever). Standardizes 404 handling ("posting not found"),
// non-2xx status errors, and bounded body reads.

import (
	"fmt"
	"io"
	"net/http"

	"github.com/zuccamia/career-planner/internal/sources/ats"
	"github.com/zuccamia/career-planner/internal/util"
)

// fetchPostingBody executes req, applies the standard ATS status-code checks,
// and returns up to sizeLimit bytes of the response body. `kind` labels error
// messages (e.g. "greenhouse", "lever"). A nil client falls back to
// util.SafeClient() so direct &Provider{} construction still works.
func fetchPostingBody(client *http.Client, req *http.Request, kind string, sizeLimit int64) ([]byte, error) {
	if client == nil {
		client = util.SafeClient()
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request %s: %w", kind, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone {
		return nil, fmt.Errorf("%s: %w: %s", kind, ats.ErrPostingNotFound, req.URL.String())
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
