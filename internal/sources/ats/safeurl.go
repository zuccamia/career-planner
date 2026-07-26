package ats

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

var blockedCIDRs = mustParsePrefixes(
	"0.0.0.0/8",
	"10.0.0.0/8",
	"100.64.0.0/10",
	"127.0.0.0/8",
	"169.254.0.0/16",
	"172.16.0.0/12",
	"192.168.0.0/16",
	"::1/128",
	"fc00::/7",
	"fe80::/10",
	"::/128",
)

type ipResolver interface {
	LookupIPAddr(ctx context.Context, host string) ([]net.IPAddr, error)
}

// ValidateFetchURL enforces the ATS outbound URL policy before any request is
// attempted.
func ValidateFetchURL(raw string) (*url.URL, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, fmt.Errorf("job posting URL is required")
	}
	u, err := url.Parse(trimmed)
	if err != nil {
		return nil, fmt.Errorf("invalid job posting URL")
	}
	if !u.IsAbs() || u.Hostname() == "" {
		return nil, fmt.Errorf("job posting URL must be absolute")
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return nil, fmt.Errorf("job posting URL must use http or https")
	}
	if u.User != nil {
		return nil, fmt.Errorf("job posting URL must not include username or password")
	}
	host := strings.ToLower(u.Hostname())
	if host == "localhost" {
		return nil, fmt.Errorf("job posting URL points to a disallowed host")
	}
	if ip := net.ParseIP(host); ip != nil && isForbiddenIP(ip) {
		return nil, fmt.Errorf("job posting URL points to a disallowed host")
	}
	return u, nil
}

func safeClient() *http.Client {
	return safeClientWithResolver(&net.Resolver{}, 15*time.Second)
}

func safeClientWithResolver(resolver ipResolver, timeout time.Duration) *http.Client {
	if resolver == nil {
		resolver = &net.Resolver{}
	}
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	dialer := &net.Dialer{Timeout: timeout}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		return safeDialContext(ctx, network, addr, dialer, resolver)
	}
	client := &http.Client{Timeout: timeout, Transport: transport}
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 3 {
			return fmt.Errorf("stopped after too many redirects")
		}
		if _, err := ValidateFetchURL(req.URL.String()); err != nil {
			return err
		}
		return nil
	}
	return client
}

func safeDialContext(ctx context.Context, network, addr string, dialer *net.Dialer, resolver ipResolver) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	if ip := net.ParseIP(host); ip != nil {
		if isForbiddenIP(ip) {
			return nil, fmt.Errorf("dial blocked for disallowed IP")
		}
		return dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
	}
	addrs, err := resolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	for _, addr := range addrs {
		if isForbiddenIP(addr.IP) {
			return nil, fmt.Errorf("dial blocked for disallowed IP")
		}
	}
	if len(addrs) == 0 {
		return nil, fmt.Errorf("host did not resolve")
	}
	return dialer.DialContext(ctx, network, net.JoinHostPort(addrs[0].IP.String(), port))
}

func isForbiddenIP(ip net.IP) bool {
	addr, ok := netip.AddrFromSlice(ip)
	if !ok {
		return true
	}
	addr = addr.Unmap()
	for _, prefix := range blockedCIDRs {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}

func mustParsePrefixes(raw ...string) []netip.Prefix {
	out := make([]netip.Prefix, 0, len(raw))
	for _, item := range raw {
		prefix, err := netip.ParsePrefix(item)
		if err != nil {
			panic(err)
		}
		out = append(out, prefix)
	}
	return out
}
