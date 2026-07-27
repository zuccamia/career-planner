# Career Planner

Local-first web app for tracking a job search — companies, applications, people, and
outreach threads — with LLM-assisted research and drafting.

Your data lives in your browser (SQLite-WASM on OPFS). The Go server holds nothing:
it serves the bundle, proxies Google OAuth for optional Drive snapshots, and relays
LLM calls.

**Try it:** https://career-planner-ecuctbkvkq-uc.a.run.app

## Your data stays yours

The public demo is safe to share — the server has no database. Everything you
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

### Where the LLM key lives

Two options:

- **Server-side key.** Intended for self-hosters running this app for their
  own use: set `LLM_*` on the machine you're running and the key persists
  across browsers, private windows, and IndexedDB wipes — no re-entering it
  every time. The public demo also happens to use this path (with a per-IP
  rate limit) so first-time visitors have working AI features immediately,
  but the primary audience is you-running-it-for-yourself.
- **Browser-side key (BYOK).** Configured in Settings → AI provider against
  any OpenAI-compatible endpoint (OpenAI, Groq, Together, Ollama Cloud,
  MiniMax, self-hosted vLLM/LM Studio, etc.). The key is stored in this
  browser's IndexedDB and **never sent to the server** — the browser calls
  the provider directly. BYOK overrides the server-side key when both exist,
  which is how demo visitors can opt out of the shared key.

Either way the server assembles prompts and sanitizes responses, so results
are identical across the two paths. With BYOK the server sees the prompt
text and the raw model response — never the key.

**CORS caveat (BYOK only):** OpenAI, Groq, and Together allow browser calls.
Some OpenAI-compatible endpoints (notably older self-hosted setups) block
cross-origin requests — if your test connection fails with a CORS error,
either self-host the app on the same origin as your provider, or fall back
to the server-side key path.

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
| `LLM_PROVIDER` | `anthropic` or `openai-compatible` — optional (see below) |
| `LLM_MODEL`, `LLM_BASE_URL`, `LLM_API_KEY` | LLM endpoint — optional (see below) |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | required only for Drive snapshots |
| `GOOGLE_OAUTH_SCOPES` | override Drive scopes (defaults to appdata + file) |

**LLM config is optional.** Set `LLM_*` if you're running the app for your
own use — the key lives on the server so it survives browser wipes and
switching browsers. Leave them unset to use the browser-only path: configure
the key in Settings → AI provider (kept in this browser's IndexedDB). See
[Where the LLM key lives](#where-the-llm-key-lives) for the tradeoffs.

## Commands

- `make dev` — build CSS, build, run on `:8080`
- `make test` — Go tests
- `npm run test:e2e` — Playwright (runs on `:8081`, LLM disabled, fresh OPFS per test)
- `go run ./cmd/seed` — regenerate `web/static/local/samples/sample.sqlite` (add `-append` to keep existing rows)

## Contributing

Fork, branch, test, PR. Open an issue first for anything substantial.

## License

TBD.
