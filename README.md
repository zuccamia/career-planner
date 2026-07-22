# Career Planner

Career Planner is a local-first web app for organizing company research, building lightweight dossiers, and tracking outreach during a job search.

It runs as a Go web application with SQLite-backed storage by default, so you can use it locally without setting up external infrastructure. LLM integrations are supported for research and generation workflows, but the core application is designed around a local-first development experience.

## Features

- **Local-first by default** with SQLite-backed storage
- **Company tracking** for storing and managing target companies
- **Dossier generation** for compiling company summaries, product signals, internship notes, and tech stack clues
- **Engineering blog notes** to collect and organize technical writing from companies
- **People tracking** for recruiters, hiring managers, and other contacts
- **Communication threads** for recording outreach history and follow-up context
- **Optional LLM-powered workflows** for generation and summarization features
- **Simple server-rendered UI** using Go templates and Tailwind CSS

## Tech Stack

- **Backend:** Go
- **Database:** SQLite (`modernc.org/sqlite`)
- **Frontend:** HTML templates + Tailwind CSS
- **End-to-end testing:** Playwright
- **Build tooling:** Make, npm

## Local Development Setup

### Prerequisites

Make sure you have the following installed:

- Go `1.25.0` or compatible
- Node.js and npm

### Getting started

1. Clone the repository.
2. Install JavaScript dependencies.
3. Copy the example environment file.
4. Start the development server.

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

### How local development works

- `make dev` builds Tailwind CSS assets
- compiles the development binary from `cmd/dev`
- loads environment variables from `.env`
- builds the web server from `cmd/web`
- starts the app locally on port `8080` by default

By default, the app stores data in a local SQLite database file:

```text
career-planner.sqlite3
```

This makes the project easy to run and evaluate locally without additional services.

## Configuration

The application reads configuration from environment variables.

### App configuration

- `APP_ADDR` — server bind address (default: `:8080`)
- `APP_ENV` — application environment name
- `DATABASE_PATH` — path to the SQLite database file (default: `career-planner.sqlite3`)

### LLM configuration

LLM-backed features are configurable through the following environment variables:

- `LLM_PROVIDER` — supported values include `anthropic` and `openai-compatible`
- `LLM_MODEL` — model name to use
- `LLM_BASE_URL` — API base URL
- `LLM_API_KEY` — API key when required by the selected provider

Notes:

- For `anthropic`, `LLM_BASE_URL` defaults to `https://api.anthropic.com/v1`
- For `openai-compatible`, set `LLM_BASE_URL` explicitly
- For local OpenAI-compatible providers, `LLM_API_KEY` may be optional
- If LLM configuration is missing or intentionally left blank, some generation features may be unavailable

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

## Testing

### Go tests

```bash
make test
```

### End-to-end tests

```bash
npm run test:e2e
```

The Playwright test configuration starts the app against a dedicated SQLite database under `tmp/playwright` and uses a test-only reset endpoint to keep runs isolated.

## Project Structure

```text
cmd/dev/                      # local development runner
cmd/web/                      # web server entrypoint
internal/app/                 # app wiring and configuration
internal/communications/      # communication threads and message workflows
internal/companies/           # company domain logic
internal/db/                  # database helpers and schema setup
internal/dossiers/            # dossier generation and storage
internal/engineering_blogs/   # engineering blog note tracking
internal/http/                # HTTP router, handlers, and rendering helpers
internal/people/              # people/contact management
internal/sources/             # external integrations and source clients
web/templates/                # HTML templates
web/static/                   # generated and source static assets
tests/e2e/                    # Playwright end-to-end tests
```

## Contributing

Contributions are welcome.

If you want to contribute:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests locally
5. Open a pull request with a clear description of the change

For substantial changes, it is helpful to open an issue first to discuss the approach.

## License

License: **TBD**.