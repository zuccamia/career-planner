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
| Lookup company | ✅ | ❌ | ❌ |
| Build dossier | ✅ | ✅ | ❌ |
| Extract JD | ✅ | ✅ | ❌ |
| Brag tags, résumé, summary, message | ✅ | ❌ | ❌ |
| Discover | ✅ | 🌐 for Ashby + unknown hosts¹ | ✅ |

¹ Greenhouse, Lever, Eightfold, SmartRecruiters, Workable expose CORS-open
APIs — browser hits them directly. Ashby (HTML, no CORS) and unknown hosts
need a BYOK scraper.

## Routing rule

Per capability, per flow: **use the server instance when the operator
provides it; otherwise use BYOK; if neither is present, the flow is
unavailable**. This rule collapses shapes A, B, and C into one decision.

Concretely:

- LLM: browser LLM if configured; else server route (via
  `/api/{domain}/{action}`) if `LLM_*` set. Static host has no server route.
- Scraper: browser scraper if configured; else server scraper via
  `/api/companies/scrape-dossier` or `/api/applications/scrape`; else the flow
  degrades to whatever text the user pasted.
- Search: browser search if configured; else server SearXNG (via
  `/api/discover/run` on server-LLM deploys, or `/api/discover/search`
  on BYOK-LLM + server-search deploys).

When BYOK LLM is active on a deploy that also has a server LLM, the browser
still uses BYOK LLM: prompt assembly and parsing move client-side, saving
one round trip. Same for scraper and search.

## Static host caveats

Every stage must be BYOK. Missing config throws a user-facing error at
request time. Discover works without a BYOK scraper for CORS-open ATS URLs
(see footnote above); Ashby and unknown hosts need one.

## Where the pieces live

Server (`internal/`)

- `/api/{domain}/{action}`: full server-side flow endpoints, used when no
  BYOK LLM.
- `/api/companies/scrape-dossier` and `/api/applications/scrape`: return scraped
  enrichment only, so BYOK-LLM users can borrow the server scraper without
  also borrowing the LLM.

Browser (`web/static/js/`)

- Prompt templates: `web/static/i18n/prompts/{module}/{name}.{en,vi}.json`
  (same files the server loads at boot).
- Prompt builders + response parsers: `web/static/js/prompt-handlers/{module}/{name}.mjs`,
  1:1 ports of the Go `Build*Prompt` / `Finalize*` pairs.
- Source clients: `web/static/js/sources/{llm,scrape,search}/client.mjs`.
- Discover composer: `web/static/js/clients/discover/service.mjs`.

## Tailor tool loop

The only flow with a multi-turn tool-calling loop. Both LLM paths share
the same loop; 🌐 always executes tool calls against local FTS
(`brag_entries_fts` + resumes) — that's where the brag inventory lives.

| Path                    | When                 | Prompt | LLM | Parse | Tools |
|-------------------------|----------------------|:------:|:---:|:-----:|:-----:|
| `tailorInBrowser`       | BYOK LLM active      |   🌐   | 🌐  |  🌐   |  🌐   |
| `tailorOnServer`        | Server LLM available |   🖥️   | 🖥️  |  🖥️   |  🌐   |
| `tailorOnServerBundled` | Neither (fallback)   |   🖥️   | 🖥️  |  🖥️   |   —   |

```
   build prompt + tool schemas
             │
             ▼
    ┌── LLM turn ──┐
    │              │
    │ tool_calls   │ final content
    ▼              ▼
 dispatch     parse draft ─► return
  local       (search_brags   → brag_entries_fts BM25)
              (search_resumes → resumes LIKE)
    │
    └─ append results, next turn

   on {tools_unsupported | tool_loop_failed | parse_fail}
      └─► fallback → bundled rank+draft (`tailorOnServerBundled`)
```

Exit conditions (all failures route to the bundled fallback):

- **Return** — final draft (no `tool_calls`) parses.
- **Cap** — hits `MAX_TOOL_ITERATIONS = 6` → `tool_loop_failed`.
- **Empty turn** — neither `tool_calls` nor content → `tool_loop_failed`.
- **Provider rejects tools** — 400 with `tool`-related `error.param` → `tools_unsupported`.

Endpoints:

- `POST /api/applications/tailor/turn` — server tool-loop, per turn.
- `POST /api/applications/tailor` — bundled fallback, one shot.
