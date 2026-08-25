package ats

import "errors"

// ErrPostingNotFound is returned when the ATS API definitively signals the
// posting no longer exists (currently: HTTP 404). Callers use errors.Is on
// this sentinel to distinguish "the job is gone" from transient/format
// failures — the former should drop the URL, the latter can fall back to
// the search snippet.
var ErrPostingNotFound = errors.New("posting not found")
