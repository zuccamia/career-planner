-- Migration 003 — fold dossier columns into companies (1:1 relationship,
-- no history). Copies the latest dossier per company, then drops the table.

ALTER TABLE companies ADD COLUMN careers_url TEXT NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN company_summary TEXT NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN what_the_company_does TEXT NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN target_customers_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE companies ADD COLUMN product_areas_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE companies ADD COLUMN business_model_clues_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE companies ADD COLUMN recent_product_launches_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE companies ADD COLUMN company_culture_notes_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE companies ADD COLUMN has_internships INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN internship_seasons_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE companies ADD COLUMN internship_summary TEXT NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN major_tech_stacks_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE companies ADD COLUMN dossier_reasoning TEXT NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN dossier_updated_at TEXT NOT NULL DEFAULT '';

UPDATE companies SET
  careers_url = d.careers_url,
  company_summary = d.company_summary,
  what_the_company_does = d.what_the_company_does,
  target_customers_json = d.target_customers_json,
  product_areas_json = d.product_areas_json,
  business_model_clues_json = d.business_model_clues_json,
  recent_product_launches_json = d.recent_product_launches_json,
  company_culture_notes_json = d.company_culture_notes_json,
  has_internships = d.has_internships,
  internship_seasons_json = d.internship_seasons_json,
  internship_summary = d.internship_summary,
  major_tech_stacks_json = d.major_tech_stacks_json,
  dossier_reasoning = d.dossier_reasoning,
  dossier_updated_at = d.dossier_updated_at
FROM (
  SELECT company_id,
         careers_url, company_summary, what_the_company_does,
         target_customers_json, product_areas_json, business_model_clues_json,
         recent_product_launches_json, company_culture_notes_json,
         has_internships, internship_seasons_json, internship_summary,
         major_tech_stacks_json,
         reasoning   AS dossier_reasoning,
         updated_at  AS dossier_updated_at
  FROM dossiers
  WHERE id IN (SELECT MAX(id) FROM dossiers GROUP BY company_id)
) AS d
WHERE companies.id = d.company_id;

DROP TABLE dossiers;
