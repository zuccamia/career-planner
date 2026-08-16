# sources

External connectors behind small interfaces.

- `llm/` — LLM client abstraction (Anthropic, OpenAI-compatible).
- `scrape/` — web scraper abstraction (`Client` interface). Backends:
  `firecrawl` (hosted, uses `/v1/scrape` + `/v1/map`) and `crawl4ai`
  (self-host, uses `/md` + `/html` with browser-side link extraction to
  synthesize a domain map). Loaded from `SCRAPER_*` env vars via `LoadConfig`;
  boot without config is non-fatal.
- `ats/` — job-posting fetch: `Provider` interface + `Registry` routing by URL.
  Providers: `greenhouse`, `lever`, `ashby` (all via public JSON APIs);
  `generic` HTML/JSON-LD fallback for when no ATS-specific provider matches.
  `scrape_fallback` wraps a `scrape.Client` and replaces `generic` as the
  registry fallback when a scraper is configured — better on JS-rendered
  careers pages. `lookup.go` exposes `LookupATSURL`, which calls
  `scrape.Map` and filters URLs against host patterns from
  `web/static/data/ats-providers.json` (Greenhouse, Lever, Ashby, Workday,
  SmartRecruiters, Workable, Google Careers, Microsoft Careers, Eightfold,
  and a `careers.*` "internal" fallback) — used by the dossier builder to
  auto-fill `ats_url` when only a company website is known.
  Planned: Workday first-class provider.

Planned connectors: Hacker News, Reddit, profile/web search.
