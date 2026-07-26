.PHONY: dev web build test kill clean css

BIN_DIR := bin

dev:
	@mkdir -p $(BIN_DIR)
	npm run build:css
	go build -o $(BIN_DIR)/dev ./cmd/dev
	./$(BIN_DIR)/dev

web:
	@mkdir -p $(BIN_DIR)
	npm run build:css
	go build -o $(BIN_DIR)/web ./cmd/web
	./$(BIN_DIR)/web

build:
	@mkdir -p $(BIN_DIR)
	npm run build:css
	go build -o $(BIN_DIR)/dev ./cmd/dev
	go build -o $(BIN_DIR)/web ./cmd/web

css:
	npm run build:css

test:
	go test ./...

kill:
	@pids=$$(lsof -tiTCP:8080 -sTCP:LISTEN 2>/dev/null); \
	if [ -n "$$pids" ]; then kill $$pids; fi

clean:
	rm -rf $(BIN_DIR)