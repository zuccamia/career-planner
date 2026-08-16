# Career Planner

[![CI](https://github.com/zuccamia/career-planner/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/zuccamia/career-planner/actions/workflows/ci.yml)
[![GH Pages](https://github.com/zuccamia/career-planner/actions/workflows/deploy-gh-pages.yml/badge.svg?branch=main)](https://github.com/zuccamia/career-planner/actions/workflows/deploy-gh-pages.yml)
[![Cloud Run](https://github.com/zuccamia/career-planner/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/zuccamia/career-planner/actions/workflows/deploy.yml)

Privacy-first job-search tracker with a built-in AI assistant. Your data lives
in your browser (SQLite-WASM on OPFS) and backs up to a local folder — or your
own Google Drive.

**Try it:** https://zuccamia.github.io/career-planner/ — public, bring your own LLM key.

## What it's for

Companies you're researching, applications in flight, people you've talked to,
threads mid-conversation, the résumé you shipped for each role, and a personal
library of accomplishments the AI pulls from when it drafts a reply or tailors
a CV. All connected, all yours.

**"I just found a role I'd love — but I've never heard of the company."**
Type the name. The assistant researches what they do, target customers, tech
stack, culture signals, ATS, internships — saved into your company page.

**"I'm tired of copy-pasting LinkedIn threads into ChatGPT to draft a reply."**
Paste once. Every message with that person lives in one searchable thread,
linked to their company and application. Drafts pull your full history so
replies sound like you.

**"This role needs a tailored CV."**
One button generates a résumé from your profile + the application + what you
know about the company, saved to a per-company folder on disk or in Drive.

**"Where does my pipeline actually stand?"**
Sankey of stage transitions, 30-day activity chart.

**"Find me a role I'd want at any of the companies I care about."**
Dashboard → Discover fans your saved companies out across shared-host ATS
platforms, ranks the top 10 fresh postings, and links them straight into
your applications list.

## Data ownership

- **Your browser owns the database** — OPFS-backed SQLite, one per browser
  profile. Different browsers don't sync by default.
- **Backups go to your filesystem.** Point Settings at a local folder;
  snapshots land there directly. Google Drive is offered as an off-device
  option.
- **Clearing site data wipes the local DB** — snapshot first.
- **Managing storage over time:** snapshot per season and start fresh, or
  bulk-delete last cycle's applications while keeping companies and contacts
  so next season's applications match up to the same records.

## The AI assistant

The demo runs entirely in your browser — no server, no shared keys. Bring
your own key against any OpenAI-compatible endpoint (OpenAI, Groq, Together,
Ollama Cloud, MiniMax, vLLM, LM Studio…). Configure in Settings → AI
provider; stored in the browser's IndexedDB and called directly from the
browser. Self-hosting? Set `LLM_*` env vars so a shared key persists across
browser wipes.

## Web scraping (optional)

Company research and job-description extraction get better when the assistant
can fetch pages directly. Point Settings → Web scraper at your own Firecrawl
(hosted) or Crawl4AI (self-hosted) instance; the key stays in your browser
and requests go straight to the scraper. Skip it and the assistant works
from what you paste in. Self-hosting? Set `SCRAPER_*` env vars.

## Job discovery (optional)

Dashboard → Discover needs a web-search provider to find fresh postings
across shared-host ATS platforms. Point Settings → Web search at your own
Brave / Tavily key (BYOK, browser-direct) or self-host SearXNG. Skip it and
the button is hidden. Self-hosting? Set `SEARCH_*` env vars.

## Run it locally

Requires Go 1.25+ and Node.

```bash
git clone git@github.com:zuccamia/career-planner.git
cd career-planner
npm install
cp .env.example .env    # optional: fill in LLM_* and/or Google OAuth
make dev                # → http://localhost:8080
make test               # Go tests
npm run test:e2e        # Playwright on :8081
```

Leave `LLM_*` unset to run fully on-device (BYOK from Settings). See
[`docs/self-hosting.md`](docs/self-hosting.md) for Drive snapshots, scraper
backends, and deploy config.

## Credits

This app stands on:

- [SQLite](https://sqlite.org/) via [`@sqlite.org/sqlite-wasm`](https://github.com/sqlite/sqlite-wasm) — Public Domain
- [`modernc.org/sqlite`](https://gitlab.com/cznic/sqlite) (pure-Go SQLite driver used by `cmd/seed` to build the demo dataset) — BSD-3-Clause
- [D3](https://d3js.org/) and [`d3-sankey`](https://github.com/d3/d3-sankey) — ISC
- [Typst.ts](https://github.com/Myriad-Dreamin/typst.ts) (in-browser Typst → PDF for résumés) — Apache-2.0
- [`@llamaindex/liteparse-wasm`](https://www.npmjs.com/package/@llamaindex/liteparse-wasm) (in-browser PDF → Markdown for résumé import) — MIT
- [Mammoth.js](https://github.com/mwilliamson/mammoth.js) (in-browser DOCX → HTML for résumé import) — BSD-2-Clause
- [Turndown](https://github.com/mixmark-io/turndown) (HTML → Markdown pass on DOCX résumés) — MIT
- [Tailwind CSS](https://tailwindcss.com/) — MIT
- [Playwright](https://playwright.dev/) — Apache-2.0
- [`golang.org/x/time`](https://pkg.go.dev/golang.org/x/time) — BSD-3-Clause

## License

TBD.
