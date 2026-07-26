# Career Planner

Career Planner is a local-first web app for organizing company research, building lightweight dossiers, and tracking outreach during a job search.

All application data lives in your browser (SQLite-in-WebAssembly, persisted to OPFS). The Go server holds no user data — it serves the static browser bundle, proxies OAuth for optional Google Drive snapshots, and runs stateless LLM prompts on behalf of the browser client.

## Features

- **Local-first storage** — SQLite runs in the browser via WebAssembly and persists to OPFS
- **Company tracking** with LLM-assisted candidate suggestions
- **Dossier generation** — company summaries, product signals, internship notes, tech stack clues
- **Engineering blog notes** to collect and organize technical writing from companies
- **People tracking** for recruiters, hiring managers, and other contacts
- **Communication threads** with LLM-assisted summaries and message drafts
- **Optional snapshots** to Google Drive or a picked local folder
- **Sample dataset** loadable from the settings page (50 apps / 12 companies / 24 people)

## Tech Stack

- **Server:** Go — static file serving + stateless LLM RPC
- **Client:** vanilla JS modules + Tailwind CSS
- **Client-side database:** sqlite-wasm on OPFS
- **End-to-end testing:** Playwright (fresh browser context per test)
- **Build tooling:** Make, npm

## Local Development Setup

### Prerequisites

- Go `1.25.0` or compatible
- Node.js and npm

### Getting started

```bash
git clone https://github.com/zuccamia/career-planner.git
cd career-planner
npm install
cp .env.example .env
make dev
```

Then open:

```text
http://localhost:8080
```

The root path redirects to `/local/dashboard`. First load bootstraps the in-browser SQLite schema from `/api/db/schema.sql`.

### How local development works

- `make dev` builds Tailwind CSS assets, compiles `cmd/dev`, and runs it
- `cmd/dev` loads `.env`, builds `cmd/web`, and starts the app on port `8080`

## Configuration

The server reads configuration from environment variables.

### App configuration

- `APP_ADDR` — server bind address (default: `:8080`)

### LLM configuration

- `LLM_PROVIDER` — supported values: `anthropic`, `openai-compatible`
- `LLM_MODEL` — model name
- `LLM_BASE_URL` — API base URL (defaults to `https://api.anthropic.com/v1` for `anthropic`)
- `LLM_API_KEY` — API key (may be optional for local OpenAI-compatible providers)

If LLM configuration is missing or blank, generation/summarization endpoints return an error and the UI falls back accordingly.

Example `.env.example`:

```env
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=your-model-name
LLM_API_KEY=your_key_here
```

## Available Commands

### Make targets

- `make dev` — build CSS, build the dev binary, and run the local server
- `make web` — build CSS, build the web binary, and run it
- `make build` — build both development and web binaries
- `make css` — build Tailwind CSS assets
- `make test` — run Go tests
- `make clean` — remove compiled binaries

### npm scripts

- `npm run build:css` — build minified Tailwind CSS output
- `npm run watch:css` — rebuild Tailwind CSS on changes
- `npm run test:e2e` — run Playwright end-to-end tests
- `npm run test:e2e:headed` — run Playwright tests in headed mode

### Regenerating the sample dataset

The "Load sample" button on the Settings page fetches `web/static/local/samples/sample.sqlite`. To rebuild it:

```bash
go run ./cmd/seed
```

Seed wipes existing rows by default. Pass `-append` if you want to add on top of the current sample DB instead.

Then commit the updated file.

## Testing

### Go tests

```bash
make test
```

### End-to-end tests

```bash
npm run test:e2e
```

Playwright launches the app on port `8081` with the LLM disabled. Each test gets a fresh browser context, so OPFS starts empty — no server-side reset is needed.

## Project Structure

```text
cmd/dev/                      # local development runner
cmd/web/                      # web server entrypoint
cmd/seed/                     # regenerates web/static/local/samples/sample.sqlite
internal/app/                 # app wiring
internal/applications/        # LLM-backed job description extraction
internal/communications/      # LLM-backed thread summaries + message drafts
internal/companies/           # LLM-backed company candidate suggestions
internal/db/                  # embedded schema.sql (served to the browser)
internal/dossiers/            # LLM-backed dossier generation
internal/http/                # HTTP router, RPC handlers, local page shells
internal/shared/              # small shared helpers
internal/sources/llm/         # LLM client abstraction
web/static/local/js/          # browser modules (pages, db, storage, ui, entities)
web/static/local/samples/     # checked-in sample.sqlite dataset
web/templates/local/          # thin HTML shells for the local-first pages
tests/e2e/                    # Playwright end-to-end tests
```

## Contributing

Contributions are welcome.

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests locally
5. Open a pull request with a clear description of the change

For substantial changes, it is helpful to open an issue first to discuss the approach.

## License

License: **TBD**.
