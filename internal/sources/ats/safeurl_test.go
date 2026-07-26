package ats

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestValidateFetchURLRejectsUnsafeForms(t *testing.T) {
	tests := []struct {
		name string
		in   string
	}{
		{name: "credentials", in: "https://user:pass@example.com/job"},
		{name: "file scheme", in: "file:///etc/passwd"},
		{name: "localhost", in: "http://localhost/job"},
		{name: "loopback", in: "http://127.0.0.1/job"},
		{name: "private", in: "http://192.168.1.10/job"},
		{name: "metadata", in: "http://169.254.169.254/latest/meta-data"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ValidateFetchURL(tc.in); err == nil {
				t.Fatalf("ValidateFetchURL(%q) unexpectedly succeeded", tc.in)
			}
		})
	}
}

func TestValidateFetchURLAllowsPublicHTTPS(t *testing.T) {
	u, err := ValidateFetchURL("https://jobs.lever.co/acme/abc-123")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := u.String(); got != "https://jobs.lever.co/acme/abc-123" {
		t.Fatalf("got %q", got)
	}
}

func TestSafeHTTPClientBlocksPrivateDNSResolution(t *testing.T) {
	client := safeClientWithResolver(staticResolver{ips: []net.IPAddr{{IP: net.ParseIP("127.0.0.1")}}}, time.Second)
	transport := client.Transport.(*http.Transport)
	_, err := transport.DialContext(context.Background(), "tcp", "example.com:80")
	if err == nil || !strings.Contains(err.Error(), "disallowed IP") {
		t.Fatalf("expected blocked dial, got %v", err)
	}
}

func TestSafeHTTPClientBlocksRedirectToUnsafeTarget(t *testing.T) {
	client := safeClientWithResolver(staticResolver{ips: []net.IPAddr{{IP: net.ParseIP("93.184.216.34")}}}, time.Second)
	req := httptest.NewRequest(http.MethodGet, "https://safe.example/job", nil)
	redirected := req.Clone(context.Background())
	redirected.URL.Host = "127.0.0.1"
	err := client.CheckRedirect(redirected, []*http.Request{req})
	if err == nil {
		t.Fatal("expected redirect rejection")
	}
}

func TestRegistryRejectsUnsafeURLBeforeDispatch(t *testing.T) {
	fallback := &stubProvider{
		name:     "generic",
		supports: func(string) bool { return true },
		posting:  Posting{Provider: "generic"},
	}
	reg := NewRegistry(fallback)
	_, err := reg.Fetch(context.Background(), "http://127.0.0.1/secret")
	if err == nil {
		t.Fatal("expected unsafe URL rejection")
	}
}

type staticResolver struct {
	ips []net.IPAddr
	err error
}

func (s staticResolver) LookupIPAddr(context.Context, string) ([]net.IPAddr, error) {
	if s.err != nil {
		return nil, s.err
	}
	return s.ips, nil
}

func TestSafeHTTPClientResolverErrorPropagates(t *testing.T) {
	client := safeClientWithResolver(staticResolver{err: errors.New("dns failed")}, time.Second)
	transport := client.Transport.(*http.Transport)
	_, err := transport.DialContext(context.Background(), "tcp", "example.com:80")
	if err == nil || !strings.Contains(err.Error(), "dns failed") {
		t.Fatalf("got %v", err)
	}
}
