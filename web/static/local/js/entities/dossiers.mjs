// Dossiers CRUD against the local sqlite DB. Column shape mirrors
// internal/db/schema.sql — array fields are stored as JSON strings in
// *_json columns; the browser (de)serializes at the edge.
//
// One dossier per company convention: getLatestByCompanyID returns the newest,
// and upsertByCompanyID replaces the existing row if one is present. This
// matches the legacy behavior where "Build" overwrites the previous dossier.

import { exec } from '../db/client.mjs';

const parseJSON = (s, fallback) => {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};

const rowToDossier = (row) => ({
  id: row.id,
  company_id: row.company_id,
  status: row.status,
  careers_url: row.careers_url,
  company_summary: row.company_summary,
  what_the_company_does: row.what_the_company_does,
  target_customers: parseJSON(row.target_customers_json, []),
  product_areas: parseJSON(row.product_areas_json, []),
  business_model_clues: parseJSON(row.business_model_clues_json, []),
  recent_product_launches: parseJSON(row.recent_product_launches_json, []),
  company_culture_notes: parseJSON(row.company_culture_notes_json, []),
  has_internships: !!row.has_internships,
  internship_seasons: parseJSON(row.internship_seasons_json, []),
  internship_summary: row.internship_summary,
  major_tech_stacks: parseJSON(row.major_tech_stacks_json, {
    languages: [], frontend: [], backend: [], infrastructure: [], data: [], tooling: [],
  }),
  created_at: row.created_at,
  updated_at: row.updated_at,
});

// Returns a Map<companyId, dossier> containing the newest dossier per company.
// Used to enrich the companies list without an N+1 fetch.
export const listLatestDossiersByCompany = async () => {
  const rows = await exec(`
    SELECT d.*
    FROM dossiers d
    INNER JOIN (
      SELECT company_id, MAX(id) AS max_id
      FROM dossiers
      GROUP BY company_id
    ) latest ON latest.company_id = d.company_id AND latest.max_id = d.id
  `);
  const map = new Map();
  for (const row of rows) map.set(row.company_id, rowToDossier(row));
  return map;
};

export const deleteDossiersByCompanyID = (companyID) =>
  exec('DELETE FROM dossiers WHERE company_id = ?', [companyID]);

export const getLatestDossierByCompanyID = async (companyID) => {
  const rows = await exec(`
    SELECT * FROM dossiers
    WHERE company_id = ?
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT 1
  `, [companyID]);
  return rows[0] ? rowToDossier(rows[0]) : null;
};

// Replace the current dossier for this company (or insert if none). Matches
// the legacy UPDATE-then-INSERT-on-zero-rows-affected pattern in the Go repo.
export const upsertDossierByCompanyID = async (dossier) => {
  if (!dossier.company_id) throw new Error('company_id required');
  const values = [
    dossier.status || 'completed',
    dossier.careers_url || '',
    dossier.company_summary || '',
    dossier.what_the_company_does || '',
    JSON.stringify(dossier.target_customers || []),
    JSON.stringify(dossier.product_areas || []),
    JSON.stringify(dossier.business_model_clues || []),
    JSON.stringify(dossier.recent_product_launches || []),
    JSON.stringify(dossier.company_culture_notes || []),
    dossier.has_internships ? 1 : 0,
    JSON.stringify(dossier.internship_seasons || []),
    dossier.internship_summary || '',
    JSON.stringify(dossier.major_tech_stacks || {}),
  ];
  await exec(`
    UPDATE dossiers SET
      status = ?, careers_url = ?, company_summary = ?, what_the_company_does = ?,
      target_customers_json = ?, product_areas_json = ?, business_model_clues_json = ?,
      recent_product_launches_json = ?, company_culture_notes_json = ?,
      has_internships = ?, internship_seasons_json = ?, internship_summary = ?,
      major_tech_stacks_json = ?, updated_at = datetime('now')
    WHERE company_id = ?
  `, [...values, dossier.company_id]);
  const changedRows = await exec('SELECT changes() AS n');
  if (changedRows[0].n > 0) return getLatestDossierByCompanyID(dossier.company_id);

  await exec(`
    INSERT INTO dossiers (
      company_id, status, careers_url, company_summary, what_the_company_does,
      target_customers_json, product_areas_json, business_model_clues_json,
      recent_product_launches_json, company_culture_notes_json,
      has_internships, internship_seasons_json, internship_summary,
      major_tech_stacks_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [dossier.company_id, ...values]);
  return getLatestDossierByCompanyID(dossier.company_id);
};

