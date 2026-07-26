package db

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolvePath(t *testing.T) {
	t.Run("default path is absolute", func(t *testing.T) {
		got, err := ResolvePath("")
		if err != nil {
			t.Fatalf("ResolvePath returned error: %v", err)
		}
		if !filepath.IsAbs(got) {
			t.Fatalf("expected absolute path, got %q", got)
		}
		if !strings.HasSuffix(filepath.ToSlash(got), "/career-planner.sqlite3") {
			t.Fatalf("expected default db filename, got %q", got)
		}
	})

	t.Run("relative path is resolved", func(t *testing.T) {
		got, err := ResolvePath("tmp/test.db")
		if err != nil {
			t.Fatalf("ResolvePath returned error: %v", err)
		}
		if !filepath.IsAbs(got) {
			t.Fatalf("expected absolute path, got %q", got)
		}
		if !strings.HasSuffix(filepath.ToSlash(got), "/tmp/test.db") {
			t.Fatalf("expected resolved suffix, got %q", got)
		}
	})
}

func TestIsSafeTestPath(t *testing.T) {
	tests := []struct {
		name string
		path string
		want bool
	}{
		{name: "playwright exact file", path: "/tmp/playwright/test.sqlite3", want: true},
		{name: "nested playwright path", path: "/var/folders/abc/tmp/playwright/another.sqlite3", want: true},
		{name: "blank", path: "", want: false},
		{name: "default app db", path: "/Users/me/career-planner.sqlite3", want: false},
		{name: "other tmp path", path: "/tmp/not-playwright/test.sqlite3", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsSafeTestPath(tt.path); got != tt.want {
				t.Fatalf("IsSafeTestPath(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}

func TestResetRejectsUnsafePath(t *testing.T) {
	unsafePath := filepath.Join(t.TempDir(), "app.sqlite3")
	err := Reset(context.Background(), unsafePath)
	if err == nil {
		t.Fatal("expected Reset to reject unsafe path")
	}
	if !strings.Contains(err.Error(), "unsafe") {
		t.Fatalf("expected unsafe-path error, got %v", err)
	}
}
