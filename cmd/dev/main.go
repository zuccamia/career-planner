package main

import (
	"bufio"
	"context"
	"errors"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func main() {
	root, err := os.Getwd()
	if err != nil {
		log.Fatal(err)
	}

	binDir := filepath.Join(root, "bin")
	binPath := filepath.Join(binDir, "web")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		log.Fatal(err)
	}

	if err := loadDotEnv(filepath.Join(root, ".env")); err != nil {
		log.Fatal(err)
	}

	build := exec.Command("go", "build", "-o", binPath, "./cmd/web")
	build.Dir = root
	build.Stdout = os.Stdout
	build.Stderr = os.Stderr
	cssBuild := exec.Command("npm", "run", "build:css")
	cssBuild.Dir = root
	cssBuild.Stdout = os.Stdout
	cssBuild.Stderr = os.Stderr
	if err := cssBuild.Run(); err != nil {
		log.Fatal(err)
	}
	if err := build.Run(); err != nil {
		log.Fatal(err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cmd := exec.Command(binPath)
	cmd.Dir = root
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin

	if err := cmd.Start(); err != nil {
		log.Fatal(err)
	}

	childDone := make(chan error, 1)
	go func() {
		childDone <- cmd.Wait()
	}()

	select {
	case err := <-childDone:
		if err != nil {
			log.Fatal(err)
		}
	case <-ctx.Done():
		if cmd.Process != nil {
			_ = cmd.Process.Signal(os.Interrupt)
		}

		select {
		case err := <-childDone:
			if err != nil && !errors.Is(err, os.ErrProcessDone) {
				var exitErr *exec.ExitError
				if !errors.As(err, &exitErr) {
					log.Fatal(err)
				}
			}
		case <-time.After(3 * time.Second):
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
			<-childDone
		}
	}
}

func loadDotEnv(path string) error {
	file, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}

		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		if _, exists := os.LookupEnv(key); exists {
			continue
		}

		value = strings.TrimSpace(value)
		value = strings.Trim(value, `"'`)
		if err := os.Setenv(key, value); err != nil {
			return err
		}
	}

	return scanner.Err()
}
