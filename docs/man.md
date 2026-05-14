# Career Planner Manual

## NAME

**career** — a local-first, CLI-based personal career planning tool

## SYNOPSIS

```
career <command> [<subcommand>] [options]
```

## DESCRIPTION

**career** stores all data as flat Markdown and YAML files on the local filesystem. The skills inventory and gap analysis work offline; opportunity parsing, criteria checking, and resume tailoring use a configured LLM provider (bring your own API key).

All commands operate on a **workspace** — a directory initialized with `career init`. Commands must run from within a workspace (or any subdirectory).

i18n is via `gettext`. Set `language` in `config.yml` or the `LANGUAGE` env var. English (`en`) is the source; Vietnamese (`vi`) ships in v1.

## COMMAND INDEX

| Section | Commands |
| --- | --- |
| WORKSPACE | `init`, `status`, `config llm`, `config llm test` |
| JOB CRITERIA | `criteria edit`, `criteria show`, `criteria check` |
| RESUME | `resume edit`, `resume render` |
| BRAG | `brag add`, `brag list`, `brag show` |
| OPPORTUNITIES | `opportunity add`, `opportunity parse`, `opportunity list`, `opportunity show` |
| SKILLS | `skills list`, `skills add`, `skills remove`, `skills browse` |
| GAP ANALYSIS | `gap` |

Commands marked *(AI)* require a configured LLM provider in `config.yml`. They exit **3** when no provider is configured.

## COMMANDS

### WORKSPACE

**career init** [*directory*] [**--language** *lang*]

:   Initialize a new workspace. Creates starter templates for `config.yml`, `criteria.yml`, `resume.yml`, `skills/inventory.yml`, and copies the bundled ESCO subset and AI coaching files into `data/`. Defaults to the current directory.

    **--language** *lang*
    :   CLI language. `en` (default) or `vi`.

**career status**

:   Terminal dashboard: active opportunities, days since last brag, skills coverage, upcoming deadlines, criteria fit. Also surfaces workspace warnings inline — opportunities with no status update in 30+ days, skills inventory not updated in 6+ months, no brag entries in the last quarter, resumes with no YAML sidecar, and orphaned files.

**career config llm**

:   Interactively configure the LLM provider. Walks through a preset list — Anthropic Console, Ollama Cloud, Local Ollama, OpenAI, OpenRouter, or Custom (openai-compatible) — and prompts for `base_url`, `model`, and the name of the env var holding the API key (blank for local Ollama). Rewrites the `llm:` block in `config.yml`, preserving comments and other sections.

    The API key itself is never read or stored — only the env var *name*. If the variable is already exported (or the provider needs no key), the wizard sends a small "ping" to verify; otherwise it prints the expected `export` line and points at `career config llm test`.

**career config llm test**

:   Re-runnable connection check. Resolves the API key from `api_key_env` (or skips when no key is required) and sends a short "say ok" prompt. Exits **3** when the LLM is not configured (missing block/field, unbound env var) and **1** on provider errors (HTTP, malformed body, network) — the failure message includes the provider's diagnostic snippet.

### JOB CRITERIA

The criteria file captures preferences and dealbreakers across five dimensions: **function**, **culture**, **growth**, **compensation**, **location**.

**career criteria edit** [**--editor**]

:   Walk through criteria dimension by dimension. Current values as defaults, list fields are comma-separated, `-` clears.

    **--editor**
    :   Open `criteria.yml` directly. Useful for bulk edits or preserving comments.

**career criteria show**

:   Print a formatted criteria summary, highlighting empty or incomplete dimensions.

**career criteria check** *opportunity* *(AI)*

:   Compare a tracked opportunity against the criteria via the configured LLM. The model judges each dimension's fit (`strong` / `ok` / `weak` / `violation` / `unknown`), surfaces dealbreaker violations with quoted context from the posting, and writes the results back onto the opportunity file in two places:

    - **Frontmatter** — a compact summary (`alignment`, `dealbreaker_count`, `scored_dimensions`, `criteria_hash`, `checked_at`). `career status` and `career opportunity show` read this without rerunning the LLM.
    - **Body** — the `## Pros` and `## Cons` sections are fully rewritten with the per-dimension positives (Pros) and negatives + dealbreaker violations (Cons). These sections are auto-managed; anything in them is overwritten on each `criteria check` run. The `## Notes` section is user-only and stays untouched.

### RESUME

`resume.yml` is the master content for resume generation. It has a `header` (name, contact, links), a planning-only `target` field (used as LLM context, never rendered), an `objective` (rendered as the resume's summary), `experience` and `education` entries, and free-form `extras` (e.g., projects, talks). Each experience entry can carry `tags` that link to matching brag entries.

**career resume edit**

:   Open `resume.yml` in `$EDITOR` (or `editor:` from `config.yml`, fallback `vim`).

**career resume render** [**--for** *opportunity*]

:   Print the resume to standard output as markdown.

    Without `--for`, a deterministic render of the master `resume.yml` — experience and education are sorted most-recent first; empty sections are skipped.

    **--for** *opportunity* *(AI)*
    :   Ask the configured LLM to tailor the resume to that opportunity. The model receives the master resume, the `target` field, and the opportunity's frontmatter + body; it reorders and rephrases bullets to emphasize JD-relevant content, drops irrelevant bullets, and never invents experience the user doesn't have.

    To save the rendered resume, redirect: `career resume render --for acme > resumes/acme.md`. Status messages and errors go to stderr so they don't pollute the captured markdown.

### BRAG

An achievements log — record entries when you ship something significant. Recommended cadence: at least once per quarter. Inspired by Julia Evans' brag documents and Google's XYZ format ("Accomplished [X] as measured by [Y] by doing [Z]").

Brag entries are markdown files in `brag/` named `YYYY-MM-DD-{slug}.md`. Each entry's frontmatter holds `date`, `project`, and `tags`. The `tags` field is the hook into `resume.yml`: when an experience entry's `tags` overlap, `resume render --for` is positioned to pull brag content into the prompt as an additional bullet pool (planned enhancement).

**career brag add** [*title*] [**--date** *YYYY-MM-DD*]

:   Create a new entry from the XYZ template and open it in `$EDITOR`. The slug is `{date}-{slugified title}`. If a file with that slug already exists, `-2`, `-3`, … are appended.

    *title*
    :   Short title for the entry. Prompted if omitted.

    **--date** *YYYY-MM-DD*
    :   Override the entry date. Defaults to today.

**career brag list** [**--last** *N*] [**--tag** *tag*]

:   List entries as a Rich table, most recent first. Defaults to the 10 most recent.

    **--last** *N*
    :   Limit the table to `N` entries.

    **--tag** *tag*
    :   Show only entries whose frontmatter `tags` contains `tag` (case-insensitive exact match).

**career brag show** *entry*

:   Render a brag entry's markdown to the console. Matches by exact slug first, then by substring against slug or derived title; disambiguates with a prompt when multiple match.

### OPPORTUNITIES

**career opportunity add** [*title*] [**--url** *url*] [**--no-editor**]

:   Create an opportunity file. Either *title* or `--url` must be provided. The editor opens to a Markdown template with frontmatter (role, company, location, work type, URL, salary range, status, posted date, deadline, applied date, created date, attachments, required skills) and body sections (description, pros, cons, notes).

    **--url** *url*
    :   Fetch the page and run a layered, best-effort structural extraction:

        1. **Schema.org `JobPosting` JSON-LD** — richest source, embedded in most reputable boards (Microsoft, Greenhouse, Lever, Workday, LinkedIn). Populates role, company, location, dates, work_type (when `TELECOMMUTE`), salary, and a plain-text description.
        2. **Open Graph + standard meta tags** — `og:title`, `og:site_name`, `og:description` fallback.
        3. **`<title>` element** — last-resort title only.

        Fetch failures still create the file with the URL recorded and a warning. SPA-only sites that don't pre-render anything produce a near-empty file — use `opportunity parse` for those.

    **--no-editor**
    :   Skip opening the editor. Useful for scripting/tests.

**career opportunity parse** *url* [**--title** *text*] [**--no-editor**] *(AI)*

:   Create an opportunity by asking the LLM to extract the full field set in a single pass — title, role, company, location, work_type, dates, salary, required_skills, description. The deterministic JSON-LD / Open Graph extractor is **not** consulted on the happy path; the LLM reads the stripped page directly.

    Exits **3** if no LLM provider is configured. Network/API/JSON-parse failures print a warning and **fall back to the deterministic extractor** (`extract_job_posting`) so the file is still populated with whatever JSON-LD / Open Graph fields the page exposes.

    **--title** *text*
    :   Override the extracted title (the `role` field is cleared so the two don't drift).

    **--no-editor**
    :   Skip opening the editor.

**career opportunity list** [**--status** *status*]

:   List tracked opportunities (all by default).

    **--status** *status*
    :   Free-form match (case-insensitive). Suggested values: `active`, `applied`, `interviewing`, `offered`, `rejected`, `closed`, `withdrawn`. You can also use your own labels (`OA`, `first interview`, `recruiter screen`, etc.) — `career status` treats anything other than `closed`, `rejected`, or `withdrawn` as an open opportunity.

**career opportunity show** *opportunity*

:   Print the full details. Matches against slugs in `opportunities/` (exact slug wins, then substring match on slug or title; a disambiguation prompt is shown if more than one matches).

### SKILLS

**career skills list** [**--category** *category*]

:   Display the inventory with self-ratings, one-line examples, ESCO codes.

    **--category** *category*
    :   Filter by ESCO category (e.g. `digital`, `communication`, `leadership`).

**career skills add** *skill* [**--rating** *N*] [**--example** *text*]

:   Add a skill. *skill* is fuzzy-matched against the bundled ESCO taxonomy; multiple matches prompt to pick. No match → stored with a user-defined label and no ESCO code.

    **--rating** *N* — 1 (beginner) to 5 (expert). Prompted if omitted.
    **--example** *text* — one-line real-world example. Prompted if omitted. e.g. `--example "Built a CI/CD pipeline serving 50 microservices at Acme Corp"`.

**career skills remove** *skill*

:   Remove a skill from the inventory.

**career skills browse** *query*

:   Search the bundled ESCO skills taxonomy by keyword. Returns a ranked table with type (knowledge vs. skill/competence) and a description snippet. Useful for translating informal language into taxonomy terms (e.g. `career skills browse "client communication"`). Pair with `career skills add "<name>"` to record.

### GAP ANALYSIS

**career gap** *opportunity* [**--suggest**]

:   Compare the user's skills inventory against the opportunity's required skills. Outputs matched (with examples), missing, and partial matches (skill present but lower rating than expected). *opportunity* matches filenames in `opportunities/` (without extension).

    **--suggest** *(AI)*
    :   Send results to the LLM for gap-closing suggestions (courses, projects, certifications). Exits **3** if no provider configured.

## CONFIGURATION

Workspace settings live in `config.yml`:

| Key | Purpose |
| --- | --- |
| `llm.provider` | `anthropic` or `openai-compatible` (covers OpenAI, Ollama local/cloud, Together, Fireworks, OpenRouter, MiniMax, and any OpenAI-Chat-Completions gateway). |
| `llm.base_url` | API endpoint. Required for `openai-compatible`; defaults to `https://api.anthropic.com/v1` for `anthropic`. |
| `llm.api_key_env` | Env var *name* holding the key (keys never stored in files). Required for `anthropic`; optional for `openai-compatible` (omit for local Ollama — request goes without `Authorization`). |
| `llm.model` | Model identifier (e.g. `claude-sonnet-4-20250514`, `gpt-4o`, `llama3.1:8b`). |
| `language` | CLI language: `en` (default) or `vi`. Also via `LANGUAGE` env var. |
| `editor` | Editor command. Defaults to `$EDITOR`, fallback `vim`. |

## ENVIRONMENT

**EDITOR** — Editor for `brag add`, `criteria edit --editor`, `opportunity add`, `resume edit`.
**LANGUAGE** — CLI language override (`en`, `vi`).
**ANTHROPIC_API_KEY**, **OPENAI_API_KEY**, etc. — API key for AI features. The env var name is configurable via `llm.api_key_env`.

## FILES

```
my-career/
├── config.yml              Configuration (LLM provider, language, editor)
├── criteria.yml            Job criteria (5 dimensions)
├── resume.yml              Master resume content (header, target, objective, experience, …)
├── skills/inventory.yml    Skills inventory (ESCO-coded, with examples)
├── brag/YYYY-MM-DD-*.md    Achievement entries (XYZ format)
├── resumes/                Rendered resume markdown files (typically `<opp-slug>.md`)
├── opportunities/*.md      Tracked opportunities
├── assessments/            (reserved for future decision frameworks)
├── data/
│   ├── coaching/           AI coaching system-prompt.md + policies.md (editable)
│   ├── esco-skills.yml     Bundled ESCO subset (~1,000 skills)
│   ├── esco-occupations.yml
│   ├── esco-occupation-skills.yml
│   ├── esco-skill-hierarchy.yml
│   ├── crosswalk.csv       ESCO ↔ O*NET mapping
│   └── cache/              Cached API responses
└── locale/<lang>/LC_MESSAGES/career.mo   Translations
```

## INTERNATIONALIZATION

i18n via Python `gettext`. English source; Vietnamese (`vi`) ships in v1. Translatable surfaces: CLI strings, help, errors, templates, this man page. Translation files in `locale/<lang>/LC_MESSAGES/` — create a `.po` from the provided `.pot` template and compile with `msgfmt`.

ESCO labels exist in 25 EU languages but not Vietnamese. With `language: vi`, the CLI is in Vietnamese while taxonomy labels remain in the user's chosen ESCO language (default English).

## INSTALLATION

```
pip install career-planner
```

Requires Python 3.10+. No optional extras — AI features use the same `httpx` already in the core dependency set.

## EXIT CODES

**0** Success. **1** General error. **2** Workspace not found. **3** Missing configuration (e.g. an AI command run with no LLM provider).

## EXAMPLES

Initialize a workspace and configure the LLM:

    $ career init my-career
    $ cd my-career
    $ career config llm
    $ export ANTHROPIC_API_KEY=sk-ant-...
    $ career config llm test

Fill in your job criteria and master resume:

    $ career criteria edit
    $ career resume edit

Add a skill with an example:

    $ career skills browse "client communication"
    $ career skills add "Python programming" --rating 4 \
        --example "Built data pipeline processing 2M records/day"
    $ career skills list

Track an opportunity (manual entry or AI-parsed from URL):

    $ career opportunity add "Senior Engineer at Acme Corp"
    $ career opportunity parse https://example.com/jobs/12345

Check fit and skill gaps:

    $ career criteria check senior-engineer-at-acme-corp
    $ career gap senior-engineer-at-acme-corp
    $ career gap senior-engineer-at-acme-corp --suggest

Generate a tailored resume:

    $ career resume render --for senior-engineer-at-acme-corp \
        > resumes/senior-engineer-at-acme-corp.md

Record an achievement:

    $ career brag add "Cut p99 latency by 30%"
    $ career brag list --last 5

Daily dashboard:

    $ career status

Vietnamese interface:

    $ career init my-career --language vi
    # or set in config.yml: language: vi

## AUTHORS

Career Planner is an open-source project.

## BUGS

Report issues at the project's GitHub repository.

## SEE ALSO

**esco**(7) — European Skills, Competences, Qualifications and Occupations classification.
**onet**(7) — O\*NET Occupational Information Network.
Julia Evans, "Get your work recognized: write a brag document" — https://jvns.ca/blog/brag-documents/
Google XYZ Resume Format — "Accomplished [X] as measured by [Y] by doing [Z]."
