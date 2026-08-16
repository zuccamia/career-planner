package discover

import (
	"testing"
)

func TestDeriveLocationContext(t *testing.T) {
	cases := []struct {
		name       string
		in         []string
		wantMode   LocationMode
		wantPhys   []string
		wantRemote bool
	}{
		{"empty", nil, LocationModeAny, nil, false},
		{"only remote", []string{"Remote"}, LocationModeRemoteOnly, nil, true},
		{"only remote flavored", []string{"Remote (US)", "Remote — EMEA", "Remote-first"}, LocationModeRemoteOnly, nil, true},
		{"cities only", []string{"New York, NY", "London"}, LocationModeCitiesOnly, []string{"New York, NY", "London"}, false},
		{"cities and remote", []string{"NYC", "Remote"}, LocationModeCitiesOrRemote, []string{"NYC"}, true},
		{"whitespace and blanks", []string{"", "  ", "Remote "}, LocationModeRemoteOnly, nil, true},
		{"non-remote 'remote-friendly' is a city", []string{"New York (remote-friendly)"}, LocationModeCitiesOnly, []string{"New York (remote-friendly)"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := deriveLocationContext(tc.in)
			if got.Mode != tc.wantMode {
				t.Errorf("mode: got %q want %q", got.Mode, tc.wantMode)
			}
			if got.RemoteOK != tc.wantRemote {
				t.Errorf("remote_ok: got %v want %v", got.RemoteOK, tc.wantRemote)
			}
			if len(got.PhysicalLocations) != len(tc.wantPhys) {
				t.Fatalf("physical_locations len: got %v want %v", got.PhysicalLocations, tc.wantPhys)
			}
			for i, p := range tc.wantPhys {
				if got.PhysicalLocations[i] != p {
					t.Errorf("physical[%d]: got %q want %q", i, got.PhysicalLocations[i], p)
				}
			}
		})
	}
}
