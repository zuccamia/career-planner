package dossiers

// Defines prompts for generating company dossiers.

const dossierSystemPrompt = `You are a meticulous company research analyst for a job-search application.
Your job is to generate a useful company dossier from confirmed company details.

Return valid JSON only.
Do not include markdown.
Prefer omission over guessing.
Only include technologies explicitly mentioned or strongly evidenced by official sources such as official engineering blogs, developer docs, or careers content.`

const dossierUserPrompt = `Generate exactly one JSON object with these keys:
- careers_url
- company_summary
- what_the_company_does
- target_customers
- product_areas
- business_model_clues
- recent_product_launches
- company_culture_notes
- has_internships
- internship_seasons
- internship_summary
- major_tech_stacks

Company details:
- official_name: %q
- website: %q
- ats_url: %q
- ats_provider: %q

Rules:
- company_summary should be 3 to 6 sentences
- what_the_company_does should be 1 to 3 concise sentences and should clearly describe the company's core product or service
- target_customers, product_areas, business_model_clues, recent_product_launches, company_culture_notes, internship_seasons must be arrays of strings
- recent_product_launches should focus on recent notable launches, releases, or major product announcements if evidenced
- each recent_product_launches entry must begin with a date in YYYY-MM-DD, YYYY-MM, or YYYY format and use exactly this format:
  <date> | <launch title> | Product area: <product area> | Target customers: <target customers> | Summary: <brief factual summary>
- company_culture_notes should capture concise, evidence-based observations from company values pages, engineering blogs, or careers pages
- has_internships must be a boolean and only true when there is evidence of internship offerings
- internship_seasons should only include seasons with evidence, such as Spring, Summer, Fall, or Winter
- internship_summary should be 2 to 3 sentences summarizing whether internships exist, which seasons appear supported, and the strength/source of evidence; leave empty rather than guess
- major_tech_stacks must be an object with keys: languages, frontend, backend, infrastructure, data, tooling
- only include URLs if they are plausible official URLs
- leave fields empty rather than guess`
