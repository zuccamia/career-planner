# Career Planner Manual

## NAME

**career** — a local-first, CLI-based personal career planning tool

## SYNOPSIS

```
career <command> [<subcommand>] [options]
```

## DESCRIPTION

**career** is an open-source career planning tool that stores all data as flat Markdown and YAML files on the local filesystem. It provides structured career planning features (skills management, gap analysis, career path exploration) without requiring any cloud service or AI provider. Optional AI-enhanced features are available via a bring-your-own API key model.

All commands operate on a **workspace** — a directory initialized with `career init` containing the user's career data. Commands must be run from within a workspace directory (or a subdirectory of one).

The tool supports internationalization (i18n) via Python's `gettext` module. Set the `language` field in `config.yml` or the `LANGUAGE` environment variable to change the CLI language. English (`en`) and Vietnamese (`vi`) are supported in v1.

## COMMANDS

### WORKSPACE

**career init** [*directory*]

:   Initialize a new career workspace. Creates the workspace directory structure with starter templates for `profile.yml`, `config.yml`, `criteria.yml`, and `skills/inventory.yml`. If *directory* is omitted, initializes in the current directory.

    The bundled ESCO skill taxonomy (~1,000 tech/knowledge-worker skills) and pre-computed JobHop career transition matrix are copied into `data/`.

    The AI coaching system prompt and policies are copied into `data/coaching/` (see AI COACHING POLICIES below).

**career status**

:   Display a terminal dashboard summarizing the current state of the workspace. Shows active opportunities and their statuses, days since last brag entry, skills coverage summary across active opportunities, upcoming deadlines, and profile completeness.

### PROFILE

**career profile edit**

:   Open `profile.yml` in the user's editor. The profile contains the user's current role, target role, career history, values, and constraints. Fields are pre-populated with guided prompts on first run.

**career profile show**

:   Print a formatted summary of the current profile to the terminal.

### JOB CRITERIA

**career criteria edit**

:   Open `criteria.yml` in the user's editor. The criteria file captures the user's job preferences and dealbreakers across five dimensions: function, culture, growth, compensation, and location. Fields are pre-populated with guided prompts on first run.

    Example `criteria.yml`:

    ```yaml
    # Job Criteria — what matters to you in your next role
    # Fill in as much or as little as you can. The AI coach will help
    # you explore and refine these during coaching sessions.

    function:
      want:        # day-to-day work you enjoy
        - "hands-on backend coding"
        - "system design and architecture"
      dread:        # work you want to avoid
        - "pure people management with no coding"
      dealbreakers:
        - "no coding at all in the role"

    culture:
      preferred:    # work environment you thrive in
        - "small team, low bureaucracy"
        - "async-first communication"
      avoid:        # environments that drain you
        - "micromanagement"
        - "meeting-heavy culture"
      dealbreakers:
        - "mandatory 5-day in-office"

    growth:
      goal_2_3_years: "staff engineer or technical lead"
      motivators:
        - "hard technical problems"
        - "mentoring junior engineers"
      stuck_signals:
        - "no promotion path beyond senior"
      dealbreakers:
        - "no learning/education budget"

    compensation:
      base_minimum: 150000       # floor — below this, don't consider
      base_target: 180000        # what you're aiming for
      currency: USD
      other_important:
        - "equity with 4-year vest"
        - "health insurance"
        - "20+ PTO days"
      dealbreakers:
        - "no health insurance"
        - "base below 150K"

    location:
      preferred:
        - "San Francisco Bay Area"
        - "Remote (US time zones)"
      willing_to_relocate: false
      work_type: "remote or hybrid"
      constraints:
        - "need US work authorization sponsorship"
      dealbreakers:
        - "fully in-person required"
    ```

**career criteria show**

:   Print a formatted summary of the current job criteria to the terminal, highlighting any dimensions that are empty or incomplete.

**career criteria check** *opportunity*

:   Compare a tracked opportunity against the user's job criteria. Flags any dealbreaker violations and scores alignment across all five dimensions. Pure software — no AI required.

    This is distinct from `career gap` (which checks skills). `criteria check` evaluates fit on function, culture, growth, compensation, and location.

Inspired by Julia Evans' brag documents (https://jvns.ca/blog/brag-documents/) and Google's XYZ accomplishment format ("Accomplished [X] as measured by [Y] by doing [Z]"). This is an achievements log, not a daily journal — record entries whenever you complete a significant project, ship a feature, finish a semester, or hit a milestone. Recommended cadence: at least once per quarter or semester.

**career brag add** [**--date** *YYYY-MM-DD*]

:   Create a new achievement entry in `brag/`. Opens the user's editor with a template following the XYZ format:

    ```yaml
    ---
    date: 2026-05-11
    project: ""          # project or context name
    tags: []             # e.g., [backend, leadership, python]
    ---
    ## What I accomplished (X)

    ## How it was measured (Y)

    ## How I did it (Z)

    ## Skills demonstrated

    ## Notes
    ```

    **--date** *YYYY-MM-DD*
    :   Override the entry date. Defaults to today.

**career brag list** [**--last** *N*] [**--tag** *tag*]

:   List brag entries by date. Defaults to showing the 10 most recent entries.

    **--last** *N*
    :   Show the *N* most recent entries.

    **--tag** *tag*
    :   Filter entries by tag.

**career brag show** *entry*

:   Print the full details of a specific brag entry.

**career brag reflect** *(requires API key)*

:   Send all brag entries (or those filtered by `--last` or `--tag`) to the configured LLM for pattern analysis. The LLM identifies themes, growth areas, underrepresented skills, and potential talking points for performance reviews. Output is printed to the terminal and optionally saved to `assessments/`.

**career brag summary** [**--period** *period*]

:   Generate a plain-text summary of accomplishments for a time period, suitable for sharing with a manager or mentor. Pure software — no AI required.

    **--period** *period*
    :   Time period. Values: `quarter`, `half`, `year`, `all`. Default: `quarter`.

### RESUMES

**career add resume** *file*

:   Import a resume PDF into the workspace. The file is copied to `resumes/` as-is. A YAML sidecar file is created alongside it, prompting the user for metadata.

    Example sidecar (`resumes/resume-v1.yml`):

    ```yaml
    filename: resume-v1.pdf
    date: 2026-05-11
    target_role: Senior Software Engineer
    version: 1
    notes: Updated for Acme Corp application, emphasized backend experience
    ```

**career resume list**

:   List all stored resumes with their metadata (date, target role, version).

**career resume review** *(requires API key)*

:   Send the latest resume to the configured LLM for critique. If an active opportunity is specified with `--for` *opportunity*, the review is tailored to that role.

    **--for** *opportunity*
    :   Review the resume in the context of a specific tracked opportunity.

### OPPORTUNITIES

**career add opportunity** *title*

:   Create a new opportunity file in `opportunities/`. Opens the user's editor with a structured Markdown template containing fields for: role, company, location, salary range, required skills (as ESCO codes or free text), pros, cons, deadline, status, and notes.

**career add opportunity** **--url** *url*

:   Create a new opportunity file by fetching a job posting from a URL. In pure-software mode, the tool performs best-effort structural extraction of the page content (title, company, location, skills from common job board HTML patterns). The user is then dropped into the editor to review and complete the file.

    **--parse** *(requires API key)*
    :   Used with `--url`. Send the fetched page content to the configured LLM for intelligent extraction, including parsing unstructured descriptions into ESCO-coded skill requirements, salary ranges, and structured fields.

**career opportunity list** [**--status** *status*]

:   List tracked opportunities. Defaults to showing all.

    **--status** *status*
    :   Filter by status. Values: `active`, `applied`, `interviewing`, `offered`, `rejected`, `closed`, `withdrawn`.

**career opportunity show** *opportunity*

:   Print the full details of a specific opportunity.

### SKILLS

**career skills list** [**--category** *category*]

:   Display the user's current skills inventory with self-ratings, one-line examples, and ESCO codes.

    **--category** *category*
    :   Filter by ESCO skill category (e.g., `digital`, `communication`, `leadership`).

**career skills add** *skill* [**--rating** *N*] [**--example** *text*]

:   Add a skill to the inventory. The *skill* argument is fuzzy-matched against the bundled ESCO taxonomy. If multiple matches are found, the user is prompted to select the correct one. If no match is found, the skill is stored with a user-defined label and no ESCO code.

    **--rating** *N*
    :   Self-assessment rating from 1 (beginner) to 5 (expert). If omitted, the user is prompted interactively.

    **--example** *text*
    :   A one-line real-world example demonstrating the skill. If omitted, the user is prompted interactively. Example: `--example "Built a CI/CD pipeline serving 50 microservices at Acme Corp"`.

    Example entry in `skills/inventory.yml`:

    ```yaml
    - skill: Python programming
      esco_code: "http://data.europa.eu/esco/skill/..."
      rating: 4
      example: "Built data pipeline processing 2M records/day for analytics team"
      added: 2026-05-11
    ```

**career skills remove** *skill*

:   Remove a skill from the inventory.

**career skills browse** [**--search** *keyword* | **--for** *occupation* [**--vs** *occupation*]]

:   Explore the bundled ESCO skill taxonomy. The primary entry point is `--search`; `--for` is useful for occupation-specific exploration; the bare command prints a static tree of the hierarchy.

    **--search** *keyword*
    :   Fuzzy-search across ESCO skill labels and descriptions. Returns a ranked table of matching skills with their type (knowledge vs. skill/competence) and a description snippet. This is the most practical way to translate informal language into standardized taxonomy terms — for example, `--search "client communication"` surfaces ESCO skills whose descriptions mention client communication. Once you find the right skill, run `career skills add "<name>"` to record it in your inventory.

    **--for** *occupation*
    :   Show the skill profile for a specific ESCO occupation, grouped by skill type. The *occupation* argument is fuzzy-matched against ESCO occupation titles; ambiguous matches prompt you to pick. Useful for exploring unfamiliar fields or building a gap-analysis target before a formal `career gap` run.

    **--vs** *occupation*
    :   Used with `--for`. Compare two occupations side by side, listing overlapping skills, skills unique to the first occupation, and skills unique to the second. Useful for identifying bridge skills when planning a career transition.

    With no flags, prints the ESCO skill hierarchy as a Rich tree rooted at top-level categories (e.g., "computer programming", "manage supplies"). This is a static, printable view — there is no arrow-key navigation in v1, and skills that are not part of the hierarchy file are only reachable via `--search`. For day-to-day use, prefer `--search` for keyword lookup or `--for` for occupation-specific exploration.

### GAP ANALYSIS

**career gap** *opportunity* [**--suggest**]

:   Run a skill gap analysis comparing the user's skills inventory against the requirements listed in the specified opportunity file. Outputs a table showing matched skills (with examples), missing skills, and partial matches (skill present but at a lower rating than expected).

    *opportunity* matches against filenames in `opportunities/` (without extension).

    **--suggest** *(requires API key)*
    :   After displaying the gap analysis, send the results to the configured LLM for suggestions on how to close the identified gaps (courses, projects, certifications, etc.).

### CAREER PATHS

**career path** [**--from** *role*] [**--to** *role*] [**--online**]

:   Show common career transition paths between ESCO occupations, based on the bundled JobHop transition probability matrix. Output is rendered as an ASCII graph showing transition chains and their relative frequency.

    If `--from` is omitted, defaults to the current role in `profile.yml`. If `--to` is omitted, shows the most common next steps from the source role.

    **--from** *role*
    :   Starting occupation. Fuzzy-matched against ESCO occupation titles.

    **--to** *role*
    :   Target occupation. When both `--from` and `--to` are specified, shows the most common multi-step paths between them.

    **--online**
    :   Query the HuggingFace Datasets Server REST API for deeper or less common transition lookups beyond the bundled matrix. Requires internet access.

**career path explore**

:   Interactive mode. Given the current role from `profile.yml`, displays the most common next-step occupations and lets the user drill into any of them to see further transitions. Navigate with arrow keys, press Enter to explore a role.

### COMPARISON

**career compare** *opportunity1* *opportunity2* [**--advise**]

:   Generate a side-by-side comparison of two tracked opportunities across all dimensions present in their files (salary, location, skills match, growth potential, etc.). Outputs a weighted decision matrix. The user is prompted to assign weights to each dimension if not previously set.

    **--advise** *(requires API key)*
    :   After displaying the comparison, send the results to the configured LLM for nuanced reasoning about trade-offs.

### AI CHAT

**career chat** *(requires API key)*

:   Start an open-ended career coaching conversation with the configured LLM. The conversation is contextualized with the user's profile, skills inventory, active opportunities, and recent brag entries. The session is saved to `conversations/` as a timestamped Markdown file.

    The coaching session is governed by the system prompt and policies in `data/coaching/` (see AI COACHING POLICIES below).

    If vector search is enabled (see `career memory enable`), the conversation also retrieves relevant context from past sessions.

    Type `/quit` or press Ctrl-D to end the session.

### DATA MANAGEMENT

**career data download** *dataset*

:   Download optional datasets to expand the tool's bundled data.

    Available datasets:

    *esco-full* — Full ESCO taxonomy (~13,000 skills, all occupations, all languages).

    *onet-full* — Full O\*NET database (923+ occupations, all skill/knowledge/ability descriptors).

**career data update**

:   Check the HuggingFace Datasets Server for a newer version of the JobHop dataset. If a newer version is found, recompute the transition probability matrix from the API and update the bundled file in `data/`. Prints the current matrix version date and the latest available version.

### VALIDATION

**career validate**

:   Lint the workspace for completeness and freshness. Checks for: missing or empty profile fields, opportunities with no status update in 30+ days, skills inventory not updated in 6+ months, no brag entries in the last quarter, resume with no YAML sidecar, and orphaned files. Exits with code 0 if all checks pass, 1 otherwise.

**career timeline**

:   Render an ASCII timeline of the user's career history (from `profile.yml`) and future goals. Past roles are shown with durations; future targets are shown with target dates if set.

### VECTOR SEARCH (ADVANCED)

**career memory enable**

:   Initialize LanceDB in `data/.vectordb/` and index all existing content (brag entries, conversations, opportunity files, profile). New content is indexed automatically on creation. Requires the `career-planner[memory]` extra to be installed.

**career memory search** *query*

:   Semantic search across all indexed workspace content. Returns ranked results with snippets and source file paths.

### MCP SERVER

**career mcp start** [**--transport** *transport*] [**--port** *port*]

:   Start the career planner as an MCP server, exposing workspace data and tools to MCP-compatible clients (Claude Desktop, Cursor, custom agents).

    **--transport** *transport*
    :   Transport protocol. Values: `stdio` (default), `sse`, `streamable-http`.

    **--port** *port*
    :   Port for HTTP-based transports. Default: 8000.

    To create a Notion dashboard from career data, run both the career planner MCP server and the official Notion MCP server (`@notionhq/notion-mcp-server`), then use an MCP client (e.g., Claude Desktop) to orchestrate between them. See NOTION INTEGRATION below.

## AI COACHING POLICIES

The `data/coaching/` directory contains configuration files that govern how the AI behaves during `career chat` and other AI-enhanced commands. These files are user-editable, allowing customization of the coaching experience.

**`data/coaching/system-prompt.md`** — The system prompt sent to the LLM at the start of every coaching session. Default template:

```markdown
You are a career coach for {{name}}, who is currently a {{current_role}}
and is working toward becoming a {{target_role}}.

## Your coaching principles

- Be understanding and supportive, but always truthful — never give
  false reassurance or empty praise.
- Ground your advice in the user's actual skills, experience, and
  brag entries — reference specific examples when possible.
- When you don't know something (e.g., job market conditions in a
  specific region), say so clearly rather than guessing.
- Ask clarifying questions before giving major career advice.
- Present trade-offs honestly — every career decision has costs.
- Respect the user's autonomy — offer perspectives, not directives.
- When discussing skill gaps, be specific and actionable.
- Tailor your language to the user's experience level.

## Job criteria intake

Before providing career advice, you must understand the user's job
criteria across five dimensions. Start by reading `criteria.yml` —
the user may have already filled in some or all of it.

- If criteria are COMPLETE: acknowledge them briefly (e.g., "I can
  see you're looking for X, Y, Z — let me work with that") and
  proceed to coaching. Do NOT re-ask what you already know.
- If criteria are PARTIALLY filled: use what's there, and only ask
  about the missing or vague dimensions. Reference what you already
  know so the user sees you've read their file.
- If criteria are EMPTY: walk through each dimension below
  conversationally. Do not rush — explore one dimension at a time,
  ask follow-up questions, and help the user articulate what they
  may not have put into words yet.

In all cases, pay special attention to dealbreakers — these are
non-negotiable constraints that should eliminate options early.
When you learn new criteria during conversation, suggest the user
update `criteria.yml` to keep it current.

### 1. Function
What kind of work do they want to do day to day? What work would
they dread? What are their dealbreakers?
- Examples to explore: hands-on coding vs. architecture vs. people
  management, customer-facing vs. internal, building from scratch vs.
  maintaining/optimizing, creative vs. analytical, breadth vs. depth.

### 2. Culture
What is their best (or worst) work environment? What management
style and workplace dynamic do they prefer?
- Examples to explore: structured with clear processes vs. flexible/
  startup-like, collaborative/team-oriented vs. independent/autonomous,
  fast-paced vs. steady, flat hierarchy vs. clear chain of command,
  in-person social culture vs. async-first, meeting-heavy vs.
  maker-schedule.
- Dealbreakers might include: micromanagement, on-call expectations,
  mandatory return-to-office, lack of diversity, etc.

### 3. Growth
Where do they want to be in 2–3 years? What would make them feel
challenged, motivated, and progressing? What would make them feel
stuck?
- Examples to explore: technical depth (staff/principal engineer),
  management track, domain expertise, entrepreneurship, career
  change, work-life balance optimization.
- Dealbreakers might include: no promotion path, no learning budget,
  dead-end title, no mentorship, etc.

### 4. Compensation
What is their minimum acceptable base salary? Their target? What
other compensation types matter to them?
- Components to clarify: base salary (minimum and target), signing
  bonus, equity/stock options (and vesting schedule preferences),
  annual bonus, benefits (health, retirement, parental leave, PTO),
  other perks (education budget, home office stipend, etc.).
- Dealbreakers might include: below a specific base floor, no
  equity, no health insurance, etc.

### 5. Location
Any geographic constraints? What is their preferred work arrangement?
- Components to clarify: preferred cities/regions/countries, willing
  to relocate (and under what conditions), remote vs. hybrid vs.
  in-person preference, time zone constraints, visa/work permit
  considerations.
- Dealbreakers might include: must be remote, cannot relocate,
  specific country/visa requirements, etc.

Once all five dimensions are understood, summarize them back to the
user for confirmation. The confirmed criteria are saved to
`criteria.yml` in the workspace and used to evaluate all future
opportunities.

## Context

Profile: {{profile}}
Skills: {{skills_summary}}
Active opportunities: {{opportunities_summary}}
Recent achievements: {{recent_brag_summary}}
Job criteria: {{criteria_summary}}
```

**`data/coaching/policies.md`** — Behavioral policies for the AI coaching layer. These are appended to the system prompt and govern all AI-enhanced features (chat, reflect, suggest, advise, review). Written in plain language so both the LLM and the user can read and understand them.

```markdown
# Coaching Policies

## Truthfulness
- Never fabricate job market data, salary figures, or company information.
  If uncertain, say so and suggest the user verify independently.
- Flag when advice is based on general patterns vs. specific knowledge
  about a company, role, or market.

## Supportiveness
- Be encouraging but never at the expense of accuracy. Avoid toxic
  positivity — acknowledge when a goal is difficult or unlikely.
- Validate emotions but redirect to actionable steps.

## Reliability
- Produce consistent advice across sessions. If the user's situation
  hasn't changed, similar questions should yield similar guidance.
- Always reference the user's actual data (skills, brag entries, criteria,
  profile) rather than making assumptions.

## Boundaries
- You are a thinking partner, not a therapist or a decision-maker.
  For mental health concerns, suggest professional resources.
- Do not make promises about outcomes ("you will get this job").
- Do not disparage specific companies, managers, or colleagues even
  if the user is venting about them.

## Bias awareness
- Be aware of and counteract common biases in career advice (e.g.,
  prestige bias, recency bias, survivorship bias).
- Do not assume career progression must be linear or upward.
```

Users can edit both files to customize the coaching experience. The system prompt supports `{{variable}}` placeholders that are populated from the user's profile and workspace data at runtime.

## NOTION INTEGRATION

The career planner integrates with Notion exclusively via MCP (Model Context Protocol). The tool does NOT embed any Notion API client. Instead:

1. The career planner exposes its data as an MCP server (`career mcp start`).
2. The official Notion MCP server (`@notionhq/notion-mcp-server`) handles Notion operations.
3. An MCP client (e.g., Claude Desktop, Cursor) orchestrates both servers.

Example workflow in Claude Desktop:

    User: "Read my career status and create a tracking dashboard in Notion."
    Claude: [calls career planner MCP for status data]
    Claude: [calls Notion MCP to create database and populate it]

To set up, add both MCP servers to your client's configuration (e.g., `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "career-planner": {
      "command": "career",
      "args": ["mcp", "start"]
    },
    "notionApi": {
      "command": "npx",
      "args": ["-y", "@notionhq/notion-mcp-server"],
      "env": {
        "OPENAPI_MCP_HEADERS": "{\"Authorization\": \"Bearer ntn_****\", \"Notion-Version\": \"2025-09-03\"}"
      }
    }
  }
}
```

## CONFIGURATION

The workspace is configured via `config.yml` in the workspace root. Key settings:

**llm.provider**
:   LLM provider type. Values: `openai-compatible`, `anthropic`, `ollama`.

**llm.base_url**
:   API endpoint URL.

**llm.api_key_env**
:   Name of the environment variable holding the API key. Keys are never stored in config files.

**llm.model**
:   Model identifier (e.g., `claude-sonnet-4-20250514`, `gpt-4o`, `llama3`).

**data.taxonomy**
:   Primary skill taxonomy. Values: `esco` (default), `onet`.

**data.language**
:   ESCO language code (default: `en`). Applies when using the full ESCO dataset.

**language**
:   CLI interface language. Values: `en` (English, default), `vi` (Vietnamese). Can also be set via the `LANGUAGE` environment variable.

**editor**
:   Editor command for opening files. Defaults to the `$EDITOR` environment variable, with fallback to `vim`.

## ENVIRONMENT

**EDITOR**
:   Default text editor for `brag add`, `profile edit`, and `add opportunity` commands.

**LANGUAGE**
:   CLI interface language override. Values: `en`, `vi`.

**ANTHROPIC_API_KEY**, **OPENAI_API_KEY**, or other provider keys
:   API key for AI-enhanced features. The environment variable name is configurable via `llm.api_key_env` in `config.yml`.

## FILES

```
my-career/
├── config.yml              Configuration
├── profile.yml             Career profile
├── criteria.yml            Job criteria (function, culture, growth, compensation, location)
├── skills/
│   └── inventory.yml       Skills inventory (ESCO-coded, with examples)
├── brag/                   Achievement entries (XYZ format)
│   └── YYYY-MM-DD-*.md
├── resumes/
│   ├── *.pdf               Resume files (stored as-is)
│   └── *.yml               Resume metadata sidecars
├── opportunities/
│   └── *.md                Tracked opportunities
├── assessments/
│   └── *.md                Decision frameworks and analysis
├── conversations/
│   └── *.md                Saved AI coaching sessions
├── data/
│   ├── coaching/
│   │   ├── system-prompt.md  AI coaching system prompt (editable)
│   │   └── policies.md       AI coaching behavioral policies (editable)
│   ├── esco-skills.yml     Bundled ESCO subset (~1,000 skills)
│   ├── esco-occupations.yml Bundled ESCO occupations
│   ├── transitions.yml     Pre-computed JobHop transition matrix
│   ├── crosswalk.csv       ESCO ↔ O*NET mapping
│   ├── .vectordb/          LanceDB files (if memory enabled)
│   └── cache/              Cached API responses
└── locale/                 Translation files
    └── vi/
        └── LC_MESSAGES/
            └── career.mo   Vietnamese translations
```

## INTERNATIONALIZATION

The tool uses Python's `gettext` module for i18n. English is the source language; Vietnamese (`vi`) is included in v1. All user-facing CLI strings, help text, error messages, templates, and the man page are translatable.

Translation files are located in `locale/<lang>/LC_MESSAGES/`. To contribute a new language, create a `.po` file from the provided `.pot` template and compile it to `.mo` with `msgfmt`.

Note: ESCO taxonomy labels are available in 25 EU languages but not in Vietnamese. When `language: vi` is set, the CLI interface is in Vietnamese while taxonomy labels remain in the user's chosen ESCO language (default: English).

## INSTALLATION

```
# Core (no AI)
pip install career-planner

# With AI support
pip install career-planner[ai]

# With vector search
pip install career-planner[memory]

# With MCP server
pip install career-planner[mcp]

# Everything
pip install career-planner[ai,memory,mcp]
```

Requires Python 3.10 or later.

## EXIT CODES

**0** — Success.

**1** — General error or validation failure.

**2** — Workspace not found (command run outside a workspace).

**3** — Missing configuration (e.g., AI command run without API key configured).

## EXAMPLES

Initialize a new workspace and set up a profile:

    $ career init my-career
    $ cd my-career
    $ career profile edit

Add skills with real-world examples:

    $ career skills browse --search "client communication"
    $ career skills add "Python programming" --rating 4 \
        --example "Built data pipeline processing 2M records/day"
    $ career skills list

Explore the taxonomy by occupation:

    $ career skills browse --for "data engineer"
    $ career skills browse --for "software developer" --vs "data scientist"

Record an achievement:

    $ career brag add

Set up your job criteria and check an opportunity against them:

    $ career criteria edit
    $ career criteria check staff-engineer-at-acme-corp

Track a job opportunity and check skill gaps:

    $ career add opportunity "Staff Engineer at Acme Corp"
    $ career add opportunity --url https://example.com/jobs/12345
    $ career gap staff-engineer-at-acme-corp

Explore career transition paths:

    $ career path --from "software developer" --to "product manager"
    $ career path explore

Compare two opportunities side by side:

    $ career compare staff-engineer-at-acme-corp senior-eng-at-globex

Generate a quarterly brag summary for your manager:

    $ career brag summary --period quarter

Start an AI coaching session:

    $ export ANTHROPIC_API_KEY=sk-ant-...
    $ career chat

Use in Vietnamese:

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
