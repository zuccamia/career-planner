# Web scraper deployment

The app can pull live web content (company sites, JD pages, ATS listings)
through one of two backends. Neither is required — with none configured,
dossier building uses only the structured fields (no live website content or
auto-discovered ATS URL), and JD extraction falls back to a plain-HTTP
fetcher that may fail to extract and return empty content for JS-rendered
careers pages.

| Backend | Setup | Best for |
| --- | --- | --- |
| **Firecrawl** | hosted, API key | zero infra, widest features |
| **Crawl4AI** | `docker run unclecode/crawl4ai:latest` | fully local, no vendor key |

Configure server-wide via `SCRAPER_*` env vars, or per-user in the browser
(Settings → Web scraper — key never touches the app server).

## Local: Crawl4AI in Docker

```sh
docker run -d --name crawl4ai -p 11235:11235 unclecode/crawl4ai:latest
export SCRAPER_BACKEND=crawl4ai SCRAPER_BASE_URL=http://localhost:11235
```

If browser-direct calls fail with `NetworkError` / `Failed to fetch`, allow
your origin:

```sh
docker run -d --name crawl4ai -p 11235:11235 \
  -e ALLOW_ORIGINS='https://your-app.example,http://localhost:8080' \
  unclecode/crawl4ai:latest
```

## Local: Firecrawl hosted

```sh
export SCRAPER_BACKEND=firecrawl SCRAPER_API_KEY=fc-...
# SCRAPER_BASE_URL defaults to https://api.firecrawl.dev
```

## Cloud Run

`deploy.yml` deploys a companion `scraper-demo` service running
`unclecode/crawl4ai:latest`, binds `SCRAPER_BASE_URL` on the main service to
its URL, and sets `CRAWL4AI_API_TOKEN` on the scraper from the same
`cp-scraper-api-key` secret.

**Two auth layers, both required:**

1. **Cloud Run IAM** — the service is deployed `--no-allow-unauthenticated`
   and only `cp-runtime@…` has `roles/run.invoker`. The main service's Go
   scrape client mints a Google ID token from the metadata server and sends
   it in `X-Serverless-Authorization: Bearer <id_token>` (Cloud Run's
   escape-hatch header for cases where `Authorization` is already used).
2. **crawl4ai app token** — the client also sends
   `Authorization: Bearer <CRAWL4AI_API_TOKEN>`, which crawl4ai verifies
   against `CRAWL4AI_API_TOKEN` in its env.

Self-hosting: the ID-token step is skipped automatically when
`SCRAPER_BASE_URL` isn't a `.run.app` domain, so a local crawl4ai on port
11235 works with the app token alone. If you map a custom domain to Cloud
Run, set the service `--allow-unauthenticated` and rely on the app token —
the client won't send an ID token because it can't guess the audience.

To swap to hosted Firecrawl instead: set `SCRAPER_BACKEND=firecrawl` +
`SCRAPER_API_KEY=fc-...` in GitHub Secrets and re-run the deploy.

## Capability matrix

| Feature | Firecrawl | Crawl4AI |
| --- | --- | --- |
| Scrape URL → markdown | `/v1/scrape` | `/md` |
| Map domain (ATS discovery) | `/v1/map` (deep) | synthesized from `/html` (single-page) |
| Web search fallback | `/v1/search` | ✗ |

The app uses scrape + map. `/v1/search` only helps when a company's ATS URL
isn't linked from their main site — uncommon.
