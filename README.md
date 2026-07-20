# career-planner

Blank-canvas Go webapp scaffold for a company dossier and job tracking MVP.

## Proposed structure

```text
cmd/web/                 # web server entrypoint
internal/app/            # app wiring/config
internal/http/           # router + handlers
internal/db/             # database helpers
internal/companies/      # company domain logic
internal/dossiers/       # dossier orchestration
internal/jobs/           # job tracking domain logic
internal/sources/        # external source clients/connectors
internal/views/          # template view models/helpers
web/templates/           # html templates
web/static/              # css/js/assets
migrations/              # sql migrations
```

## MVP flow

1. User enters a company name.
2. App proposes one company candidate.
3. User edits/confirms official name, website, ATS URL, ATS provider.
4. App builds a dossier with jobs, company info, and discussion links.
5. User tracks relevant jobs.

## Run

```bash
cp .env.example .env
make dev
```

Then open `http://localhost:8080`.

`make dev` builds and runs the compiled dev command from `cmd/dev`. The dev command loads `.env` from the repo root, builds `./cmd/web` to `bin/web`, and forwards `Ctrl+C` to the child server process.

## LLM configuration

Current MVP setup is direct API-key auth only.

Required environment variables:

- `LLM_PROVIDER` (`anthropic` or `openai-compatible`)
- `LLM_MODEL`
- `LLM_BASE_URL`

Required for `anthropic`:

- `LLM_API_KEY`

Notes:

- for `anthropic`, `LLM_BASE_URL` defaults to `https://api.anthropic.com/v1`
- for `openai-compatible`, set `LLM_BASE_URL` explicitly
- for `openai-compatible`, `LLM_API_KEY` may be omitted for local setups that do not require auth

The shared LLM client now supports provider-specific JSON generation via `internal/llm`.