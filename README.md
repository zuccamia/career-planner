# Career Planner

Privacy-first job-search tracker with a built-in AI assistant. Your data lives
in your browser (SQLite-WASM on OPFS) and backs up to a local folder on your
machine — or to your own Google Drive if you want off-device backups.

**Try it:** https://career-planner-ecuctbkvkq-uc.a.run.app

![Dashboard overview](docs/screenshots/dashboard.png)

## What it's for

A place to keep track of your job search: companies you're researching,
applications in flight, people you've talked to, conversations mid-thread,
the résumé you shipped for each role, and a personal library of your
accomplishments and career priorities the AI pulls from whenever it drafts
a reply or tailors a CV. All connected in one place.

Not an auto-apply app. You press submit yourself, whether that's five or
fifty a week. The app just makes research, CV tailoring, and outreach
logging fast enough that even at high volume, every application still ships
with its own tailored CV and thread of context. And your record of the
search stays yours: every draft, CV variant, thread, and dossier lives in a
folder on your disk, not on someone else's servers that could vanish if they
change pricing.

### Best used for

**"I just found a role I'd love — but I've never heard of the company."**
Type the name. The assistant guesses the canonical name, website, blog, and
ATS provider, then researches what the company actually does, target
customers, tech stack, culture signals, and whether they run internships —
all saved into your company page.
![Company research](docs/screenshots/company-dossier.png)

**"I'm tired of copy-pasting an entire LinkedIn thread into ChatGPT just to
draft a reply."**
Paste it here once. Every message you exchange with that person lives in
one searchable thread, linked to their company and any application it
belongs to. Drafts pull in your full history with them automatically, so
replies sound like you and not like a generic recruiter response.
![Thread with assistant draft](docs/screenshots/thread-draft.png)

**"This role needs a tailored CV."**
One button generates a custom résumé from your career profile + the specific
application + what you know about the company, and saves it into a per-company
folder — on your local disk or in your Drive. No new account for yet another
résumé builder.
![Tailored CV generation](docs/screenshots/resume-tailored.png)

**"Where does my pipeline actually stand?"**
A dashboard with a Sankey of stage transitions and a 30-day activity chart
of applications and outreach.
![Dashboard pipeline](docs/screenshots/dashboard-pipeline.png)

## Data ownership

- **Your browser owns the database.** OPFS-backed SQLite, one file per
  browser profile. Different browsers = different databases; they don't sync
  by default.
- **Backups go to *your* filesystem.** Point Settings at a local folder on
  your machine and snapshots land there directly — no external service in the
  loop. Google Drive is offered as an off-device option for people who want
  it; more independent hosting integrations are on the roadmap.
- **Clearing site data wipes the local DB** — snapshot from Settings first.

### Managing your data over time

Browser storage isn't infinite. A few patterns that work:

- **Snapshot per season/year.** Take a snapshot at the end of each cycle,
  wipe the DB, and start fresh — reload the snapshot any time you want to
  reference an older search.
- **Work on one period at a time.** Keep the current snapshot loaded; older
  snapshots stay parked in your folder until you need them.
- **Wipe applications, keep companies and people.** Companies and the people
  you know at them are worth preserving across cycles. Bulk-delete last
  cycle's applications from the applications list — companies and contacts
  stay, so next season's applications still match up to the same records.

### The AI assistant

Bring your own key against any OpenAI-compatible endpoint (OpenAI, Groq,
Together, Ollama Cloud, MiniMax, vLLM, LM Studio…). It's configured in
Settings → AI provider and stored in your browser's IndexedDB; the browser
calls the provider directly. If you're self-hosting for personal use, you
can also set `LLM_*` env vars so the key persists across browser wipes.

## Run it locally

Requires Go 1.25+ and Node.

```bash
git clone git@github.com:zuccamia/career-planner.git
cd career-planner
npm install
cp .env.example .env    # optional: fill in LLM_* and/or Google OAuth
make dev                # → http://localhost:8080
```

Leave `LLM_*` unset to run fully on-device (BYOK from Settings).

## Configuration

| Var | Purpose |
|---|---|
| `APP_ADDR` | bind address (default `:8080`) |
| `LLM_PROVIDER` | `anthropic` or `openai-compatible` — optional |
| `LLM_MODEL`, `LLM_BASE_URL`, `LLM_API_KEY` | LLM endpoint — optional |

### Google Drive snapshots (optional)

Only needed if you're self-hosting and want Drive snapshots. Register your
own OAuth client in Google Cloud Console, add your redirect URI
(`localhost:PORT` or your deployed domain), and drop the ID + secret into
`.env`. You can reuse the demo's credentials for a quick test at
`localhost:8080`, but for anything you actually use, register your own so
the OAuth grant doesn't route through the demo's Google Cloud project.

| Var | Purpose |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | your OAuth client credentials |
| `GOOGLE_OAUTH_SCOPES` | override Drive scopes (default: appdata + file) |

### BYOK CORS caveat

OpenAI, Groq, and Together allow browser calls. Some self-hosted
OpenAI-compatible endpoints block cross-origin — if the test call fails with
a CORS error, self-host the app on the same origin as your provider.

## Commands

- `make dev` — build CSS, build, run on `:8080`
- `make test` — Go tests
- `npm run test:e2e` — Playwright (runs on `:8081`, LLM disabled, fresh OPFS per test)

## Contributing

Fork, branch, test, PR. Open an issue first for anything substantial.

## License

TBD.
