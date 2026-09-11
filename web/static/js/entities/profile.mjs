// Career profile — overview singleton, supporting brag entries and career
// sparks, plus output artifacts (résumés and their compiled PDF attachments).
// Mirrors the single Go internal/profile/ package which houses overview,
// brags, and resume-related methods.

import { exec, transaction, decodeJSON } from '../db/client.mjs';
import { LOOKING_FOR_VALUES, SKILL_LEVELS } from '../db/schema.mjs';
import { createAttachment, deleteAttachmentsByEntity } from './attachments.mjs';

// ---- overview ----
// Career profile overview — singleton row (id=1) seeded by migration 004.
// One "about me" block per browser DB (multi-profile is a future concern).

const OVERVIEW_EDITABLE_COLS = ['name', 'headline', 'summary', 'skills_json', 'workplace_type', 'tools_json', 'looking_for', 'locations_json'];

// hydrateSkills accepts object rows from skills_json and returns a normalized
// array of {name, years?, level?} objects. Unknown levels are dropped so
// stale/invalid values don't stick around forever.
export const hydrateSkills = (raw) => {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || typeof item.name !== 'string') continue;
    const skill = { name: item.name };
    if (item.years != null && item.years !== '') skill.years = Number(item.years);
    if (item.level && SKILL_LEVELS.includes(item.level)) skill.level = item.level;
    skill.name = skill.name.trim();
    if (!skill.name) continue;
    const key = skill.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(skill);
  }
  return out;
};

// hydrateCareerSparks accepts spark-like objects and returns a trimmed ordered
// list of normalized spark objects with case-insensitive dedupe by body.
// Existing metadata (id, sort_order, etc.) is preserved from the first
// occurrence.
export const hydrateCareerSparks = (raw) => {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || typeof item.body !== 'string') continue;
    const spark = { ...item, id: item.id ?? null, sort_order: item.sort_order ?? 1, body: item.body };
    spark.body = spark.body.trim();
    if (!spark.body) continue;
    const key = spark.body.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(spark);
  }
  return out;
};

export const hydrateTools = (raw) => {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    let tool = null;
    if (typeof item === 'string') tool = item.trim();
    if (!tool) continue;
    const key = tool.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tool);
  }
  return out;
};

// hydrateLocations returns a deduped array of trimmed non-empty strings.
// Order is preserved so the user's priority ("home base first") survives
// the round-trip.
export const hydrateLocations = (raw) => {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const v = item.trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
};

// Normalize a looking_for value to one of LOOKING_FOR_VALUES. Unknown or
// missing values fall back to 'open' so a stale row can't leak into prompts
// with a garbage employment type.
const hydrateLookingFor = (raw) => {
  const v = (raw || '').toString().trim().toLowerCase();
  return LOOKING_FOR_VALUES.includes(v) ? v : 'open';
};

// Map from the caller-facing patch key to the persisted TEXT-JSON column +
// hydrator. Drives both the decode side of getOverview and the encode side of
// updateOverview, so a new JSON field only needs one entry here.
const JSON_COLS = {
  skills:    ['skills_json',    hydrateSkills],
  tools:     ['tools_json',     hydrateTools],
  locations: ['locations_json', hydrateLocations],
};

export const getOverview = async () => {
  const rows = await exec('SELECT * FROM profile_overview WHERE id = 1');
  const row = rows[0];
  if (!row) return null;
  for (const [key, [col, hydrator]] of Object.entries(JSON_COLS)) {
    row[key] = hydrator(decodeJSON(row[col], []));
  }
  row.looking_for = hydrateLookingFor(row.looking_for);
  return row;
};

// updateOverview accepts a partial patch. Only fields present in `data` (and
// in OVERVIEW_EDITABLE_COLS) are written. The flat form on the Profile page
// uses this to save one field at a time when its input blurs, without
// touching the others. (The wizard also calls this, but commits on Next/Skip
// rather than blur — same partial-patch semantics either way.)
//
// Callers can pass `skills`, `tools`, or `locations` as arrays; each is
// hydrated + JSON-encoded into its TEXT column before persistence so junk
// (empty names, bogus levels, dupes) doesn't survive the round-trip.
export const updateOverview = async (data) => {
  const patch = { ...data };
  for (const [key, [col, hydrator]] of Object.entries(JSON_COLS)) {
    if (Object.hasOwn(patch, key)) {
      patch[col] = JSON.stringify(hydrator(patch[key]));
      delete patch[key];
    }
  }
  if (Object.hasOwn(patch, 'looking_for')) {
    patch.looking_for = hydrateLookingFor(patch.looking_for);
  }
  const cols = OVERVIEW_EDITABLE_COLS.filter(c => Object.hasOwn(patch, c));
  if (!cols.length) return;
  const values = cols.map(c => (patch[c] ?? '').toString());
  await exec(
    `UPDATE profile_overview
     SET ${cols.map(c => `${c} = ?`).join(', ')},
         updated_at = datetime('now')
     WHERE id = 1`,
    values,
  );
};

export const markOnboarded = () =>
  exec(`UPDATE profile_overview SET onboarded_at = datetime('now'), updated_at = datetime('now') WHERE id = 1`);

export const clearOnboarded = () =>
  exec(`UPDATE profile_overview SET onboarded_at = NULL, updated_at = datetime('now') WHERE id = 1`);

export const getWizardProgress = async () => {
  const rows = await exec('SELECT wizard_progress FROM profile_overview WHERE id = 1');
  const raw = rows[0]?.wizard_progress;
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch { return null; }
};

export const setWizardProgress = (obj) =>
  exec(
    `UPDATE profile_overview SET wizard_progress = ?, updated_at = datetime('now') WHERE id = 1`,
    [JSON.stringify(obj)],
  );

export const clearWizardProgress = () =>
  exec(`UPDATE profile_overview SET wizard_progress = NULL, updated_at = datetime('now') WHERE id = 1`);

// ---- brag entries ----
// Brag entries — accomplishments the LLM can pull from when tailoring
// resumes or outreach. Optional company_id groups entries by "what I did at
// Stripe" without requiring it (some entries are between-jobs, personal
// projects, etc.).

const BRAG_EDITABLE_COLS = ['title', 'body', 'impact', 'tags_json', 'tags_generated_at', 'company_id', 'entry_year', 'category'];

// Category routes the brag into the matching résumé section on tailor.
// 'experience' — professional work (default; matches historical rows).
// 'project'    — hobby, school, or side projects → résumé Projects section.
// 'activity'   — interests, volunteering, clubs → résumé Activities section.
export const BRAG_CATEGORIES = ['experience', 'project', 'activity'];

// Normalize a brag category to a canonical enum token. Unknown/empty → experience.
export const coerceCategory = (raw) => {
  const value = String(raw ?? '').trim().toLowerCase();
  return BRAG_CATEGORIES.includes(value) ? value : 'experience';
};

// Callers may pass `tags` (array) or `tags_json` (string). Prefer the array
// form; fall back to decoding the string via the shared decodeJSON helper so
// malformed JSON doesn't throw here.
const sanitizeBragEntryFields = (data) => {
  const tags = Array.isArray(data.tags)
    ? data.tags
    : decodeJSON(data.tags_json, []);
  return {
    title: (data.title ?? '').toString().trim(),
    body: (data.body ?? '').toString(),
    impact: (data.impact ?? '').toString().trim(),
    tags_json: JSON.stringify(tags),
    tags_generated_at: data.tags_generated_at || null,
    company_id: data.company_id ? Number(data.company_id) : null,
    entry_year: data.entry_year ? Number(data.entry_year) : null,
    category: coerceCategory(data.category),
  };
};

const hydrateBragEntry = (row) => {
  if (!row) return row;
  return { ...row, tags: decodeJSON(row.tags_json, []) };
};

export const listBragEntries = async () => {
  const rows = await exec(`
    SELECT b.*, c.official_name AS company_name
    FROM brag_entries b
    LEFT JOIN companies c ON c.id = b.company_id
    ORDER BY b.entry_year DESC NULLS LAST, b.updated_at DESC, b.id DESC
  `);
  return rows.map(hydrateBragEntry);
};

export const countBragEntries = async () => {
  const rows = await exec('SELECT COUNT(*) AS n FROM brag_entries');
  return Number(rows[0]?.n ?? 0);
};

export const getBragEntry = async (id) => {
  const rows = await exec('SELECT * FROM brag_entries WHERE id = ?', [id]);
  return hydrateBragEntry(rows[0] || null);
};

// listByCompany — the primary consumer for later LLM resume-tailoring: pull
// every accomplishment the user recorded against this company.
export const listBragEntriesByCompany = async (companyID) => {
  const rows = await exec(
    `SELECT * FROM brag_entries WHERE company_id = ?
     ORDER BY entry_year DESC NULLS LAST, updated_at DESC, id DESC`,
    [companyID],
  );
  return rows.map(hydrateBragEntry);
};

// Preserves caller's id order; drops unknown ids silently (LLMs hallucinate).
export const listBragEntriesByIds = async (ids) => {
  const wanted = (Array.isArray(ids) ? ids : [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (!wanted.length) return [];
  const placeholders = wanted.map(() => '?').join(', ');
  const rows = await exec(
    `SELECT b.*, c.official_name AS company_name
     FROM brag_entries b
     LEFT JOIN companies c ON c.id = b.company_id
     WHERE b.id IN (${placeholders})`,
    wanted,
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return wanted.map((id) => byId.get(id)).filter(Boolean).map(hydrateBragEntry);
};

export const createBragEntry = async (data) => {
  const n = sanitizeBragEntryFields(data);
  const values = BRAG_EDITABLE_COLS.map(c => n[c]);
  await exec(
    `INSERT INTO brag_entries (${BRAG_EDITABLE_COLS.join(', ')})
     VALUES (${BRAG_EDITABLE_COLS.map(() => '?').join(', ')})`,
    values,
  );
  const rows = await exec('SELECT last_insert_rowid() AS id');
  return rows[0].id;
};

export const updateBragEntry = async (id, data) => {
  const n = sanitizeBragEntryFields(data);
  const values = BRAG_EDITABLE_COLS.map(c => n[c]);
  await exec(
    `UPDATE brag_entries
     SET ${BRAG_EDITABLE_COLS.map(c => `${c} = ?`).join(', ')},
         updated_at = datetime('now')
     WHERE id = ?`,
    [...values, id],
  );
};

export const deleteBragEntry = (id) =>
  exec('DELETE FROM brag_entries WHERE id = ?', [id]);

// ---- FTS search ----
// Backs search_brags / search_resumes tool calls (BM25 order via migration 019).

// FTS5 MATCH treats -, :, *, ^, quotes, parens, and bare AND/OR/NEAR
// as operators — a hyphen in "data-driven" is enough to throw
// SQLITE_ERROR. Wrap each whitespace-split term as a quoted phrase so
// the whole query is a literal AND of phrases with no operator parsing.
const sanitizeFtsQuery = (raw) => {
  const cleaned = String(raw ?? '').replace(/"/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned.split(' ').map((term) => `"${term}"`).join(' ');
};

export const searchBrags = async ({ query, category = null, limit = 10 } = {}) => {
  const match = sanitizeFtsQuery(query);
  if (!match) return [];
  const cap = Math.max(1, Math.min(Number(limit) || 10, 50));
  const cat = category ? coerceCategory(category) : null;
  const sql = cat
    ? `SELECT b.*, c.official_name AS company_name
       FROM brag_entries_fts f
       JOIN brag_entries b ON b.id = f.rowid
       LEFT JOIN companies c ON c.id = b.company_id
       WHERE brag_entries_fts MATCH ? AND b.category = ?
       ORDER BY bm25(brag_entries_fts) LIMIT ?`
    : `SELECT b.*, c.official_name AS company_name
       FROM brag_entries_fts f
       JOIN brag_entries b ON b.id = f.rowid
       LEFT JOIN companies c ON c.id = b.company_id
       WHERE brag_entries_fts MATCH ?
       ORDER BY bm25(brag_entries_fts) LIMIT ?`;
  const bind = cat ? [match, cat, cap] : [match, cap];
  const rows = await exec(sql, bind);
  return rows.map(hydrateBragEntry);
};

// LIKE scan (résumé corpus is tiny; this tool is a rare fallback).
// `%`/`_` stripped so LLM tokens can't act as wildcards.
export const searchResumes = async ({ query, limit = 5 } = {}) => {
  const tokens = sanitizeFtsQuery(query).replace(/[%_\\]/g, ' ').split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const cap = Math.max(1, Math.min(Number(limit) || 5, 20));
  const clauses = tokens.map(() => '(title LIKE ? OR body LIKE ?)').join(' AND ');
  const binds = tokens.flatMap((t) => [`%${t}%`, `%${t}%`]);
  const rows = await exec(
    `SELECT id, title, format, body, is_primary, application_id, updated_at
     FROM resumes
     WHERE ${clauses}
     ORDER BY is_primary DESC, datetime(updated_at) DESC, id DESC
     LIMIT ?`,
    [...binds, cap],
  );
  return rows.map(hydrateResume);
};

// ---- career sparks ----
// Career sparks — freeform criteria the user cares about. Ordered list.
// Stored flat; the Overview wizard groups them by theme for reflection, but
// the storage is a single ordered list.

export const listSparks = () => exec(
  `SELECT id, body, sort_order, created_at, updated_at
   FROM career_sparks
   ORDER BY sort_order ASC, id ASC`,
);

export const countSparks = async () => {
  const rows = await exec('SELECT COUNT(*) AS n FROM career_sparks');
  return Number(rows[0]?.n ?? 0);
};

// createSpark inserts a spark. When a priority is provided, it is stored
// directly as sort_order (lower number = higher priority; ties are allowed).
// When omitted, the spark is appended at the end (max sort_order + 1).
export const createSpark = async (body, priority) => {
  let sortOrder;
  if (priority == null || Number.isNaN(Number(priority))) {
    const rows = await exec('SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM career_sparks');
    sortOrder = Number(rows[0]?.next ?? 0);
  } else {
    sortOrder = Number(priority);
  }
  await exec(
    `INSERT INTO career_sparks (body, sort_order) VALUES (?, ?)`,
    [(body || '').toString(), sortOrder],
  );
  const idRows = await exec('SELECT last_insert_rowid() AS id');
  return idRows[0].id;
};

export const deleteSpark = (id) =>
  exec('DELETE FROM career_sparks WHERE id = ?', [id]);

// ---- resumes ----
// Resumes — versioned resume documents. Body is authoritative source; format
// is 'md' or 'typ' (Typst). Compiled PDFs are derived artifacts tracked via
// the polymorphic attachments table (see resume PDFs section below).

const RESUME_EDITABLE_COLS = ['title', 'format', 'body'];
const ALLOWED_RESUME_FORMATS = new Set(['md', 'typ']);

const sanitizeResumeFields = (data) => {
  const format = String(data.format ?? '').toLowerCase();
  return {
    title: (data.title ?? '').toString().trim(),
    format: ALLOWED_RESUME_FORMATS.has(format) ? format : 'md',
    body: (data.body ?? '').toString(),
  };
};

// application_id is set at insert only; updateResume leaves it alone.

// Coerces SQLite's 0/1 int to a real boolean so callers can `=== true` /
// truthy-check without silent mismatches.
const hydrateResume = (row) => (row ? { ...row, is_primary: !!row.is_primary } : row);

// listResumes accepts an optional { applicationId } filter — used by the
// Profile → Résumés tab when navigated to with ?application_id=… so the list
// shows only résumés tailored for that posting. Ordering is unchanged.
export const listResumes = async ({ applicationId } = {}) => {
  const filterId = Number(applicationId) || null;
  const rows = filterId
    ? await exec(
        `SELECT id, title, format, is_primary, application_id, created_at, updated_at
         FROM resumes
         WHERE application_id = ?
         ORDER BY is_primary DESC, datetime(updated_at) DESC, id DESC`,
        [filterId],
      )
    : await exec(
        `SELECT id, title, format, is_primary, application_id, created_at, updated_at
         FROM resumes
         ORDER BY is_primary DESC, datetime(updated_at) DESC, id DESC`,
      );
  return rows.map(hydrateResume);
};

export const countResumes = async () => {
  const rows = await exec('SELECT COUNT(*) AS resume_count FROM resumes');
  return Number(rows[0]?.resume_count ?? 0);
};

export const countResumesByApplication = async (applicationId) => {
  const filterId = Number(applicationId) || null;
  if (!filterId) return 0;
  const rows = await exec(
    'SELECT COUNT(*) AS resume_count FROM resumes WHERE application_id = ?',
    [filterId],
  );
  return Number(rows[0]?.resume_count ?? 0);
};

export const getResume = async (id) => {
  const rows = await exec('SELECT * FROM resumes WHERE id = ?', [id]);
  return hydrateResume(rows[0] || null);
};

export const getPrimaryResume = async () => {
  const rows = await exec('SELECT * FROM resumes WHERE is_primary = 1 ORDER BY id ASC LIMIT 1');
  return hydrateResume(rows[0] || null);
};

// createResume accepts an optional applicationId to link the row to the job
// posting it was tailored for. Left NULL for ordinary "stock" résumés.
export const createResume = async (data) => {
  const fields = sanitizeResumeFields(data);
  const applicationId = Number(data.applicationId) || null;
  const columns = [...RESUME_EDITABLE_COLS, 'application_id'];
  const values = [...RESUME_EDITABLE_COLS.map((col) => fields[col]), applicationId];
  await exec(
    `INSERT INTO resumes (${columns.join(', ')})
     VALUES (${columns.map(() => '?').join(', ')})`,
    values,
  );
  const rows = await exec('SELECT last_insert_rowid() AS id');
  return rows[0].id;
};

export const updateResume = async (id, data) => {
  const n = sanitizeResumeFields(data);
  const values = RESUME_EDITABLE_COLS.map(c => n[c]);
  await exec(
    `UPDATE resumes
     SET ${RESUME_EDITABLE_COLS.map(c => `${c} = ?`).join(', ')},
         updated_at = datetime('now')
     WHERE id = ?`,
    [...values, id],
  );
};

// Deletes the resume + its attachment rows via deleteAttachmentsByEntity
// (attachments have no FK on the polymorphic entity_id). Paired app-side rows
// and on-disk blobs stay (still referenced).
export const deleteResume = async (id) => {
  await transaction(async () => {
    await deleteAttachmentsByEntity('resume', id);
    await exec('DELETE FROM resumes WHERE id = ?', [id]);
  });
};

// setPrimary clears is_primary on every other row and sets it on this one, in
// one transaction. Passing null clears the flag from all rows (no primary).
export const setPrimaryResume = async (id) => {
  await transaction(async () => {
    await exec(`UPDATE resumes SET is_primary = 0, updated_at = datetime('now') WHERE is_primary = 1`);
    if (id) {
      await exec(`UPDATE resumes SET is_primary = 1, updated_at = datetime('now') WHERE id = ?`, [id]);
    }
  });
};

// Resume-PDF attachments. A compiled PDF is traced by two rows in the
// polymorphic `attachments` table pointing at the same on-disk file:
//   • entity_type='application', entity_id=<appId>  — surfaces in the app's
//     attachments list (existing behavior).
//   • entity_type='resume',      entity_id=<resumeId> — surfaces in a
//     "PDFs sent from this resume" list on Profile → Resumes.
// The bytes are written once via uploadAttachment; this module inserts both
// metadata rows in a single transaction.

// linkPdfToApplication takes the metadata returned from uploadAttachment plus
// (resumeId, applicationId) and creates both attachment rows atomically.
// Returns { applicationAttachmentId, resumeAttachmentId }.
export const linkPdfToApplication = async ({
  resumeId, applicationId,
  folder, storedFilename, originalFilename,
  mimeType, sizeBytes, sha256,
}) => {
  if (!resumeId) throw new Error('resumeId required');
  if (!applicationId) throw new Error('applicationId required');
  if (!folder) throw new Error('folder required');
  if (!storedFilename) throw new Error('storedFilename required');

  const base = {
    folder,
    filename: storedFilename,
    original_filename: originalFilename || storedFilename,
    mime_type: mimeType || 'application/pdf',
    size_bytes: sizeBytes || 0,
    sha256: sha256 || '',
  };
  return transaction(async () => {
    const applicationAttachmentId = await createAttachment({
      ...base, entity_type: 'application', entity_id: applicationId,
    });
    const resumeAttachmentId = await createAttachment({
      ...base, entity_type: 'resume', entity_id: resumeId,
    });
    return { applicationAttachmentId, resumeAttachmentId };
  });
};

// listPdfsForResume returns every attachment row where entity_type='resume'
// and entity_id=resumeId, joined with the paired application-side row (via
// folder+filename) so callers can render "sent to <application>" alongside.
// The join is best-effort: if the paired app row was deleted, application_*
// fields are NULL and the row still surfaces.
export const listPdfsForResume = (resumeId) => exec(
  `SELECT ra.id AS resume_attachment_id,
          ra.folder, ra.filename, ra.original_filename,
          ra.mime_type, ra.size_bytes, ra.sha256, ra.created_at,
          aa.entity_id AS application_id,
          app.role_title AS application_role_title,
          c.official_name AS application_company_name
   FROM attachments ra
   LEFT JOIN attachments aa
          ON aa.entity_type = 'application'
         AND aa.folder = ra.folder
         AND aa.filename = ra.filename
   LEFT JOIN applications app ON app.id = aa.entity_id
   LEFT JOIN companies c ON c.id = app.company_id
   WHERE ra.entity_type = 'resume' AND ra.entity_id = ?
   ORDER BY datetime(ra.created_at) DESC, ra.id DESC`,
  [resumeId],
);
