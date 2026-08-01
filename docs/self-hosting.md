# Self-hosting

Everything you need beyond `make dev`: env vars, Google Drive OAuth, and the
optional web scraper.

## Environment variables

| Var | Purpose |
|---|---|
| `APP_ADDR` | bind address (default `:8080`) |
| `LLM_PROVIDER` | `anthropic` or `openai-compatible` |
| `LLM_MODEL`, `LLM_BASE_URL`, `LLM_API_KEY` | LLM endpoint |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Drive OAuth client |
| `GOOGLE_OAUTH_SCOPES` | override Drive scopes (default: appdata + file) |
| `SCRAPER_BACKEND` | `firecrawl` or `crawl4ai` |
| `SCRAPER_BASE_URL` | override scraper endpoint |
| `SCRAPER_API_KEY` | required for Firecrawl, optional for Crawl4AI |

## BYOK CORS caveat

OpenAI, Groq, and Together allow browser calls. Some self-hosted
OpenAI-compatible endpoints block cross-origin — if the test call fails with
a CORS error, self-host the app on the same origin as your provider.

## Google Drive snapshots

Only needed if you want off-device backups to Drive. Register your own OAuth
client in Google Cloud Console, add your redirect URI (`localhost:PORT` or
your deployed domain), and drop the ID + secret into `.env`.

You can reuse the demo's credentials for a quick test at `localhost:8080`,
but for anything you actually use, register your own so the OAuth grant
doesn't route through the demo's Google Cloud project.

## Web scraping

The dossier builder can pull live company website content, and JD extraction
can fall back to a rendered scrape for non-Greenhouse/Lever/Ashby URLs, when
a scraper is configured. Two backends behind one interface:

| Backend | Setup | Best for |
|---|---|---|
| **Firecrawl** (`api.firecrawl.dev`) | `SCRAPER_BACKEND=firecrawl SCRAPER_API_KEY=fc-…` | Zero infra; widest features |
| **Crawl4AI** (self-host) | `docker run -p 11235:11235 unclecode/crawl4ai:latest`, then `SCRAPER_BACKEND=crawl4ai SCRAPER_BASE_URL=http://localhost:11235` | Fully local, single container |

Or leave `SCRAPER_*` unset and configure per-user in the browser
(Settings → Web scraper). BYOK mode calls the scraper directly from the
browser; the app server never sees the key.

Full deploy details (Cloud Run, IAM bindings, capability matrix):
[`scraper.md`](scraper.md).
