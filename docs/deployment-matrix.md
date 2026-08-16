# Deployment × BYOK matrix

Every AI flow needs an **LLM**, sometimes a **scraper**, and (Discover only)
a **web search** provider. Each capability comes from the operator's own
self-hosted instance (talking to the app server via env vars) or from the
user's BYOK key stored in the browser.

## Deployment shapes

| Shape | Meaning |
|---|---|
| **A. Hosted full** | Operator self-hosts all three: LLM, Crawl4AI, SearXNG. Server env has `LLM_*`, `SCRAPER_*`, `SEARCH_*`. Users can leave BYOK empty. |
| **B. Hosted partial** | Operator self-hosts a subset. Users BYOK the rest. Any combination of {LLM, scraper, search} may be server-side; the remainder is browser-side. |
| **C. Static** | Pre-rendered HTML (GH Pages). No `/api/*`. All three capabilities must be BYOK. |

## BYOK toggles (per user, browser-side)

| Toggle | Storage | Vendors |
|---|---|---|
| BYOK LLM | `storage/byok.mjs` | any OpenAI-compatible endpoint |
| BYOK scraper | `storage/scraper.mjs` | Firecrawl, Crawl4AI |
| BYOK search | `storage/search.mjs` | Tavily, Brave |

## Which capability, for which flow

| Flow | LLM | Scraper | Search |
|---|---|---|---|
| Guess company | ✓ | | |
| Build dossier | ✓ | ✓ | |
| Extract JD | ✓ | ✓ | |
| Brag tags, résumé, summary, message | ✓ | | |
| Discover | ✓ | ✓ (Ashby + generic hosts only) | ✓ |

## Routing rule

Per capability, per flow: **use the server instance when the operator
provides it; otherwise use BYOK; if neither is present, the flow is
unavailable**. This rule collapses shapes A, B, and C into one decision.

Concretely:

- LLM: browser LLM if configured; else server route (via
  `/api/{domain}/{action}`) if `LLM_*` set. Static host has no server route.
- Scraper: browser scraper if configured; else server scraper via
  `/api/dossiers/enrich` or `/api/applications/jd-enrich`; else the flow
  degrades to whatever text the user pasted.
- Search: browser search if configured; else server SearXNG (via
  `/api/discover/run`).

When BYOK LLM is active on a deploy that also has a server LLM, the browser
still uses BYOK LLM: prompt assembly and parsing move client-side, saving
one round trip. Same for scraper and search.

## Static host caveats

Every stage must be BYOK. Missing configuration throws a user-facing error
at request time. Discover works without a BYOK scraper only for Greenhouse
and Lever URLs (their APIs are CORS-open); Ashby and unknown hosts require
one.

## Where the pieces live

Server (`internal/`)

- `/api/{domain}/{action}`: full server-side flow endpoints, used when no
  BYOK LLM.
- `/api/dossiers/enrich` and `/api/applications/jd-enrich`: return scraped
  enrichment only, so BYOK-LLM users can borrow the server scraper without
  also borrowing the LLM.

Browser (`web/static/js/`)

- Prompt templates: `web/static/i18n/prompts/*.json` (same files the
  server loads at boot).
- Prompt builders + response parsers: `web/static/js/llm/parse/*.mjs`,
  1:1 ports of the Go `Build*Prompt` / `Finalize*` pairs.
- Clients: `llm-client.mjs`, `scrape-client.mjs`, `search-client.mjs`.
- Discover composer: `discover-client.mjs`.
