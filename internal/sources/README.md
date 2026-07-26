# sources

External connectors behind small interfaces.

- `llm/` — LLM client abstraction (Anthropic, OpenAI-compatible)
- `ats/` — job-posting fetch: `Provider` interface + `Registry` routing by URL.
  Providers: `greenhouse`, `lever`, `ashby` (all via public JSON APIs);
  `generic` HTML/JSON-LD fallback. Planned: Workday.

Planned connectors: company website/web metadata, Hacker News, Reddit,
profile/web search.
