# Career Planner

Local-first web app for tracking a job search — companies, applications, people, and
outreach threads — with LLM-assisted research and drafting.

Your data lives in your browser (SQLite-WASM on OPFS). The Go server holds nothing:
it serves the bundle, proxies Google OAuth for optional Drive snapshots, and relays
LLM calls.

## Features

- **Companies** — from a rough name, the LLM back-fills canonical name, website,
  and ATS/tech-blog links, then researches product signals, tech stack, and
  engineering-blog activity onto the company view.
- **Applications** — LLM extracts role/level/stack from a pasted job description
  or a link (link extraction is best-effort, not yet ATS-aware)
- **People** — recruiters, hiring managers, referrals
- **Threads** — communication log with LLM summaries and reply drafts
- **Snapshots** — optional export to Google Drive or a picked local folder
- **Sample data** — one-click 50-app / 12-company / 24-person seed from Settings

## Stack

Go server · vanilla JS + Tailwind · sqlite-wasm on OPFS · Playwright for E2E.

## Run it

Requires Go 1.25+ and Node.

```bash
git clone git@github.com:zuccamia/career-planner.git
cd career-planner
npm install
cp .env.example .env   # fill in LLM + optional Google OAuth creds
make dev               # → http://localhost:8080
```

## Configuration

All via env vars.

| Var | Purpose |
|---|---|
| `APP_ADDR` | bind address (default `:8080`) |
| `LLM_PROVIDER` | `anthropic` or `openai-compatible` |
| `LLM_MODEL`, `LLM_BASE_URL`, `LLM_API_KEY` | LLM endpoint |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | required only for Drive snapshots |
| `GOOGLE_OAUTH_SCOPES` | override Drive scopes (defaults to appdata + file) |

Missing LLM config disables generation endpoints; the UI degrades gracefully.

## Commands

- `make dev` — build CSS, build, run on `:8080`
- `make test` — Go tests
- `npm run test:e2e` — Playwright (runs on `:8081`, LLM disabled, fresh OPFS per test)
- `go run ./cmd/seed` — regenerate `web/static/local/samples/sample.sqlite` (add `-append` to keep existing rows)

## Layout

```
cmd/{dev,web,seed}          entrypoints
internal/{applications,communications,companies,dossiers,people}
                            LLM-backed RPC handlers
internal/{app,db,http,shared,sources/llm}
                            wiring, schema, router, LLM client
web/static/local/js/        browser: pages, db, storage, ui, entities
web/templates/local/        HTML shells
tests/e2e/                  Playwright
```

## Contributing

Fork, branch, test, PR. Open an issue first for anything substantial.

## License

TBD.
