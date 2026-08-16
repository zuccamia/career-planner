// Companies CRUD against the local sqlite DB. Column shape mirrors
// internal/companies/model.go plus the dossier fields folded into the
// companies row by migration 003 (1:1 relationship, no history).
//
// Dossier fields (careers_url, company_summary, etc.) live on the row and
// are only written by upsertCompanyDossier after a successful LLM build.
// dossier_updated_at is the empty string until a dossier has been built —
// callers use that to distinguish "never built" from "built with sparse
// content."

import { exec, decodeJSON } from '../db/client.mjs';
import { sanitizeURL } from '../ui/dom.mjs';

const EDITABLE_COLS = ['official_name', 'website', 'blog_url', 'ats_url', 'ats_provider'];

const DOSSIER_JSON_COLS = {
  target_customers_json: [],
  product_areas_json: [],
  business_model_clues_json: [],
  recent_product_launches_json: [],
  company_culture_notes_json: [],
  internship_seasons_json: [],
  major_tech_stacks_json: {
    languages: [], frontend: [], backend: [], infrastructure: [], data: [], tooling: [],
  },
};

// Rehydrates the JSON-encoded dossier columns on a company row into arrays/
// objects. Passthrough for non-dossier columns.
const hydrateCompany = (row) => {
  if (!row) return row;
  const out = { ...row };
  for (const [col, fallback] of Object.entries(DOSSIER_JSON_COLS)) {
    const key = col.replace(/_json$/, '');
    out[key] = decodeJSON(row[col], fallback);
  }
  out.has_internships = !!row.has_internships;
  return out;
};

export const countCompanies = async () => {
  const rows = await exec('SELECT COUNT(*) AS n FROM companies');
  return Number(rows[0]?.n ?? 0);
};

// Slim list projection — only what the companies list card renders. Skips
// the JSON dossier blobs to keep the payload small; the detail/dossier
// panel calls getCompany for the full row. has_internships is coerced to a
// real boolean to match getCompany's shape.
export const listCompanies = async () => {
  const rows = await exec(`
    SELECT id, official_name, website, blog_url, ats_url, ats_provider,
           has_internships, dossier_updated_at, created_at, updated_at
    FROM companies
    ORDER BY official_name COLLATE NOCASE
  `);
  return rows.map((r) => ({ ...r, has_internships: !!r.has_internships }));
};

export const getCompany = async (id) => {
  const rows = await exec('SELECT * FROM companies WHERE id = ?', [id]);
  return hydrateCompany(rows[0] || null);
};

export const findCompanyByName = async (name) => {
  const trimmed = (name || '').trim();
  if (!trimmed) return null;
  const rows = await exec(
    'SELECT * FROM companies WHERE official_name = ? COLLATE NOCASE LIMIT 1',
    [trimmed],
  );
  return hydrateCompany(rows[0] || null);
};

const sanitizeCompanyFields = (data) => ({
  official_name: (data.official_name ?? '').toString().trim(),
  website: sanitizeURL(data.website),
  blog_url: sanitizeURL(data.blog_url),
  ats_url: sanitizeURL(data.ats_url),
  ats_provider: (data.ats_provider ?? '').toString().trim(),
});

export const createCompany = async (data) => {
  const n = sanitizeCompanyFields(data);
  const values = EDITABLE_COLS.map(c => n[c]);
  await exec(
    `INSERT INTO companies (${EDITABLE_COLS.join(', ')})
     VALUES (${EDITABLE_COLS.map(() => '?').join(', ')})`,
    values,
  );
  const rows = await exec('SELECT last_insert_rowid() AS id');
  return rows[0].id;
};

export const updateCompany = async (id, data) => {
  const n = sanitizeCompanyFields(data);
  const values = EDITABLE_COLS.map(c => n[c]);
  await exec(
    `UPDATE companies
     SET ${EDITABLE_COLS.map(c => `${c} = ?`).join(', ')},
         updated_at = datetime('now')
     WHERE id = ?`,
    [...values, id],
  );
};

export const deleteCompany = (id) =>
  exec('DELETE FROM companies WHERE id = ?', [id]);

// column → extractor(dossier). Single source of truth for the SET clause and
// the values array — adding a new dossier field means one entry here, not two
// index-aligned edits across parallel lists.
const DOSSIER_COLS = {
  careers_url:                  (d) => d.careers_url || '',
  company_summary:              (d) => d.company_summary || '',
  what_the_company_does:        (d) => d.what_the_company_does || '',
  target_customers_json:        (d) => JSON.stringify(d.target_customers || []),
  product_areas_json:           (d) => JSON.stringify(d.product_areas || []),
  business_model_clues_json:    (d) => JSON.stringify(d.business_model_clues || []),
  recent_product_launches_json: (d) => JSON.stringify(d.recent_product_launches || []),
  company_culture_notes_json:   (d) => JSON.stringify(d.company_culture_notes || []),
  has_internships:              (d) => d.has_internships ? 1 : 0,
  internship_seasons_json:      (d) => JSON.stringify(d.internship_seasons || []),
  internship_summary:           (d) => d.internship_summary || '',
  major_tech_stacks_json:       (d) => JSON.stringify(d.major_tech_stacks || {}),
  dossier_reasoning:            (d) => d.reasoning || '',
};

// Overwrites the dossier fields on a company row with the LLM-generated
// payload. dossier_updated_at is stamped so callers can render freshness.
// updated_at deliberately left alone — the dossier build isn't a company
// edit and shouldn't disturb sort-by-recent-edit orderings.
export const updateCompanyDossier = async (id, dossier) => {
  const entries = Object.entries(DOSSIER_COLS);
  const setClause = entries.map(([col]) => `${col} = ?`).join(', ');
  const values = entries.map(([, extract]) => extract(dossier));
  await exec(
    `UPDATE companies SET ${setClause},
       dossier_updated_at = datetime('now')
     WHERE id = ?`,
    [...values, id],
  );
};

