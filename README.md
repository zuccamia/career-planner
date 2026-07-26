# Career Planner

Local-first web app for tracking a job search — companies, applications, people, and
outreach threads — with LLM-assisted research and drafting.

Your data lives in your browser (SQLite-WASM on OPFS). The Go server holds nothing:
it serves the bundle, proxies Google OAuth for optional Drive snapshots, and relays
LLM calls.

**Try it:** https://career-planner-ecuctbkvkq-uc.a.run.app

## Your data stays yours

The hosted demo is safe to share — the server has no database. Everything you
enter lives in your browser's private OPFS storage, keyed to your origin and
profile. Concretely:

- **Nobody else sees your data.** Two people opening the demo URL each get their
  own empty SQLite file. There is no shared backend to leak from.
- **Nothing syncs by default.** The Go server only forwards LLM API calls; it
  does not store, log, or persist your rows. Snapshots to Google Drive are
  opt-in and go to *your* Drive, not ours.
- **Clearing browser data wipes it.** OPFS lives with your other site storage.
  Clearing site data for the domain deletes your database — take a snapshot
  first from Settings if you want a backup.
- **Different browsers, browser profiles, and incognito windows have separate
  databases.** They don't share OPFS.

If you want to guarantee no data ever leaves your machine, run it locally
([Run it](#run-it)) with `LLM_*` unset — the app degrades gracefully and works
purely on-device.

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

## Contributing

Fork, branch, test, PR. Open an issue first for anything substantial.

## License

TBD.
