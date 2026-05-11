# Data Preparation Scripts

These scripts are **maintainer-only** — they download and process raw datasets
into the curated YAML/CSV files that ship with the pip package. End users
never run these.

## Prerequisites

```bash
pip install -e ".[dev]"
```

## Scripts

| Script | Input | Output | When to re-run |
|--------|-------|--------|----------------|
| `prepare_esco.py` | ESCO v1.2.1 CSV download | `esco-skills.yml`, `esco-occupations.yml`, `esco-occupation-skills.yml`, `esco-skill-hierarchy.yml` | ESCO new version (~annually) |
| `prepare_onet_crosswalk.py` | O\*NET crosswalk CSV | `crosswalk.csv` | O\*NET update (quarterly) |
| `prepare_jobhop_matrix.py` | HuggingFace REST API | `transitions.yml` | JobHop data update (irregular) |
| `prepare_all.py` | Runs all above | All data files | Full refresh |

## Usage

```bash
# Download ESCO CSVs first (manually from https://esco.ec.europa.eu/en/use-esco/download)
# Place in scripts/raw/esco/

# Then run:
python scripts/prepare_esco.py
python scripts/prepare_onet_crosswalk.py
python scripts/prepare_jobhop_matrix.py

# Or all at once:
python scripts/prepare_all.py
```

## Output

All files are written to `src/career_planner/data/` and should be committed to the repo.
