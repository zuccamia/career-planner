Read the Data Preparation Pipeline section in docs/blueprint.md.
Write or update the specified data preparation script in scripts/.

The scripts download and process raw datasets into curated YAML files
that ship with the pip package. Output files go to src/career_planner/data/.

Key constraints:
- Scripts are maintainer-only, not run by end users
- Use httpx for all HTTP requests (consistent with the main tool)
- Use PyYAML for YAML output
- Include progress indicators for long-running operations
- Add a version_date field to output files
- Filter ESCO data to ISCO Major Groups 1-3 (tech/knowledge workers)
- The transition matrix should only include transitions with ≥5 occurrences
