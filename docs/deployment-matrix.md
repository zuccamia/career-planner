# Deployment × BYOK matrix

Every AI flow needs an **LLM**, sometimes a **scraper**, and (Discover only)
a **web search** provider. Each capability comes from the operator's own
self-hosted instance (talking to the app server via env vars) or from the
user's BYOK key stored in the browser.

## Deployment shapes

| Shape | LLM | Scraper | Search | Notes |
|---|:-:|:-:|:-:|---|
| **A. Hosted full** | 🖥️ | 🖥️ | 🖥️ | Operator self-hosts everything. Users can leave BYOK empty. |
| **B. Hosted partial** | 🖥️ / 🌐 | 🖥️ / 🌐 | 🖥️ / 🌐 | Any subset server-side; the rest is BYOK. |
| **C. Static (GH Pages)** | 🌐 | 🌐 | 🌐 | No `/api/*`. Every capability must be BYOK. |

🖥️ = server-side (env-driven) · 🌐 = browser BYOK

## BYOK toggles (per user, browser-side)

| Toggle | Storage | Vendors |
|---|---|---|
| BYOK LLM | `storage/byok-llm.mjs` | any OpenAI-compatible endpoint |
| BYOK scraper | `storage/byok-scraper.mjs` | Firecrawl, Crawl4AI |
| BYOK search | `storage/byok-search.mjs` | Tavily, Brave |

## Which capability, for which flow

| Flow | LLM | Scraper | Search |
|---|:-:|:-:|:-:|
| Guess company | ✅ | ❌ | ❌ |
| Build dossier | ✅ | ✅ | ❌ |
| Extract JD | ✅ | ✅ | ❌ |
| Brag tags, résumé, summary, message | ✅ | ❌ | ❌ |
| Discover | ✅ | 🌐 for Ashby + unknown hosts¹ | ✅ |

¹ Greenhouse and Lever expose CORS-open JSON APIs, so the browser hits them
directly. Ashby is the only known-structured ATS whose posting pages aren't
CORS-friendly (HTML page, no CORS headers) — a BYOK scraper is needed to
read them, same story for unknown hosts.

## Routing rule

Per capability, per flow: **use the server instance when the operator
provides it; otherwise use BYOK; if neither is present, the flow is
unavailable**. This rule collapses shapes A, B, and C into one decision.

Concretely:

- LLM: browser LLM if configured; else server route (via
  `/api/{domain}/{action}`) if `LLM_*` set. Static host has no server route.
- Scraper: browser scraper if configured; else server scraper via
  `/api/dossiers/scrape` or `/api/applications/scrape`; else the flow
  degrades to whatever text the user pasted.
- Search: browser search if configured; else server SearXNG (via
  `/api/discover/run` on server-LLM deploys, or `/api/discover/search`
  on BYOK-LLM + server-search deploys).

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
- `/api/dossiers/scrape` and `/api/applications/scrape`: return scraped
  enrichment only, so BYOK-LLM users can borrow the server scraper without
  also borrowing the LLM.

Browser (`web/static/js/`)

- Prompt templates: `web/static/i18n/prompts/*.json` (same files the
  server loads at boot).
- Prompt builders + response parsers: `web/static/js/llm/parse/*.mjs`,
  1:1 ports of the Go `Build*Prompt` / `Finalize*` pairs.
- Clients: `llm-client.mjs`, `scrape-client.mjs`, `search-client.mjs`.
- Discover composer: `discover-client.mjs`.
