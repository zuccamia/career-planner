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
| `SEARCH_BACKEND` | `searxng` (only backend today) |
| `SEARCH_BASE_URL` | SearXNG base URL (enables Dashboard → Discover) |

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

## Job discovery

The Dashboard's **Discover** button runs a server-side pipeline (LLM expands
seed companies into candidate roles → SearXNG searches for postings → ATS
extraction → LLM ranks the top 5). It needs both `LLM_*` and a reachable
SearXNG instance; without either, the button is disabled with a tooltip
pointing back here.

| Backend | Setup |
|---|---|
| **SearXNG** (self-host, local) | See recipe below, then `SEARCH_BACKEND=searxng SEARCH_BASE_URL=http://localhost:8890` |
| **SearXNG** (Cloud Run companion) | Set `SEARCH_BACKEND=searxng` in GitHub Secrets; `deploy.yml` builds `deploy/searxng/` and binds `SEARCH_BASE_URL` on the main service. See below. |

A default `docker run searxng/searxng` won't work out of the box:
- The bot limiter 403s non-browser clients (including our Go client and curl).
- The JSON output format is off by default, but the pipeline needs it.

Mount a `settings.yml` that fixes both. Config file lives outside the repo
(it contains `secret_key`); `~/.config/searxng/` is a fine home:

```
mkdir -p ~/.config/searxng
cat > ~/.config/searxng/settings.yml <<'EOF'
use_default_settings: true
server:
  secret_key: "change-me-please"
  limiter: false
  public_instance: false
search:
  formats:
    - html
    - json
EOF
docker run -d --name searxng -p 8890:8080 \
  -v "$HOME/.config/searxng:/etc/searxng" searxng/searxng
```

Sanity check:
```
curl -s 'http://localhost:8890/search?q=test&format=json' | head -c 120
```
Should start with `{"query":"test","results":[…]}`. If you still see HTML,
the mount didn't take — verify the container sees the file with
`docker exec searxng cat /etc/searxng/settings.yml`.

Keep `limiter: false` only on private single-user instances. If the SearXNG
becomes reachable from anywhere else, re-enable it.

### Cloud Run

Set `SEARCH_BACKEND=searxng` in GitHub Secrets and `deploy.yml` builds
`deploy/searxng/` → `search-demo` (`--no-allow-unauthenticated`); the Go
client attaches `X-Serverless-Authorization` via the metadata server. Set
`BRAVE_API_KEY` too — the entrypoint sed-injects it into `settings.yml`.
`SEARCH_BASE_URL` auto-populates from the deployed URL unless pinned.

Discovery is server-only for v1 — there is no BYOK path. Deployments without
a server-side LLM (static / GH Pages) can't run it.
