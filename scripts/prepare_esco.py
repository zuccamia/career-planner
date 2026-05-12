"""Maintainer script: ESCO CSVs -> curated YAML files.

Reads the ESCO v1.2.1 English CSV package from ``scripts/raw/esco/`` and
writes four bundled files into ``src/career_planner/data/``:

* ``esco-skills.yml``            top ~1,000 skills (plus ancestors) for ISCO 1-3
* ``esco-occupations.yml``       occupations whose ISCO Major Group is 1, 2, or 3
* ``esco-occupation-skills.yml`` occupation URI -> [skill URIs]
* ``esco-skill-hierarchy.yml``   skill URI -> [parent skill URIs]

Prerequisite (manual): download the ESCO v1.2.1 English CSV package from
https://esco.ec.europa.eu/en/use-esco/download and unzip its contents into
``scripts/raw/esco/``. The directory must contain ``skills_en.csv``,
``occupations_en.csv``, ``occupationSkillRelations_en.csv``, and
``broaderRelationsSkillPillar_en.csv``.

Run with: ``python scripts/prepare_esco.py``
"""

from __future__ import annotations

import csv
import sys
from collections import Counter, defaultdict
from collections.abc import Iterable, Iterator
from datetime import date
from pathlib import Path

import yaml
from rich.console import Console
from rich.progress import (
    BarColumn,
    Progress,
    SpinnerColumn,
    TextColumn,
    TimeElapsedColumn,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = REPO_ROOT / "scripts" / "raw" / "esco"
OUT_DIR = REPO_ROOT / "src" / "career_planner" / "data"

TARGET_SKILL_COUNT = 1000
ISCO_MAJOR_GROUPS = ("1", "2", "3")

REQUIRED_CSVS = (
    "skills_en.csv",
    "occupations_en.csv",
    "occupationSkillRelations_en.csv",
    "broaderRelationsSkillPillar_en.csv",
)

ATTRIBUTION_HEADER = (
    "# Source: ESCO classification v1.2.1 (European Commission)\n"
    "# This is a modified/adapted subset. See THIRD_PARTY_NOTICES.md.\n"
)

console = Console()


def _check_inputs() -> None:
    missing = [name for name in REQUIRED_CSVS if not (RAW_DIR / name).is_file()]
    if not missing:
        return
    console.print(f"[red]Missing ESCO CSV files in {RAW_DIR}:[/red]")
    for name in missing:
        console.print(f"  - {name}")
    console.print(
        "\nDownload the ESCO v1.2.1 English CSV package from\n"
        "  https://esco.ec.europa.eu/en/use-esco/download\n"
        f"and unzip its contents into {RAW_DIR}."
    )
    sys.exit(1)


def _read_csv(path: Path) -> Iterator[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        yield from csv.DictReader(fh)


def _parse_alt_labels(raw: str, preferred: str) -> list[str]:
    """Split ESCO's newline-separated altLabels field into a deduped list.

    Drops blanks, exact duplicates of the preferred label (case-insensitive),
    and duplicates within the alt-label list itself (case-insensitive), while
    preserving original casing and order for the first occurrence.
    """
    seen: set[str] = {preferred.lower().strip()}
    out: list[str] = []
    for chunk in (raw or "").split("\n"):
        label = chunk.strip()
        if not label:
            continue
        key = label.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(label)
    return out


def _filter_occupations(rows: Iterable[dict[str, str]]) -> dict[str, dict]:
    keep: dict[str, dict] = {}
    for row in rows:
        isco = (row.get("iscoGroup") or "").strip()
        if not isco or isco[0] not in ISCO_MAJOR_GROUPS:
            continue
        uri = (row.get("conceptUri") or "").strip()
        if not uri:
            continue
        preferred = (row.get("preferredLabel") or "").strip()
        alt_labels = _parse_alt_labels(row.get("altLabels") or "", preferred)
        keep[uri] = {
            "uri": uri,
            "preferred_label": preferred,
            "alt_labels": alt_labels or None,
            "isco_code": isco,
            "code": (row.get("code") or "").strip() or None,
            "description": (row.get("description") or "").strip() or None,
        }
    return keep


def _load_occupation_skill_relations(
    rows: Iterable[dict[str, str]], occupation_uris: set[str]
) -> dict[str, set[str]]:
    mapping: dict[str, set[str]] = defaultdict(set)
    for row in rows:
        occ_uri = (row.get("occupationUri") or "").strip()
        skill_uri = (row.get("skillUri") or "").strip()
        if not occ_uri or not skill_uri or occ_uri not in occupation_uris:
            continue
        mapping[occ_uri].add(skill_uri)
    return dict(mapping)


def _rank_skills(occ_to_skills: dict[str, set[str]]) -> Counter[str]:
    counter: Counter[str] = Counter()
    for skill_uris in occ_to_skills.values():
        counter.update(skill_uris)
    return counter


def _load_skill_hierarchy(rows: Iterable[dict[str, str]]) -> dict[str, list[str]]:
    parents: dict[str, set[str]] = defaultdict(set)
    for row in rows:
        child = (row.get("conceptUri") or "").strip()
        parent = (row.get("broaderUri") or "").strip()
        if not child or not parent:
            continue
        parents[child].add(parent)
    return {uri: sorted(p) for uri, p in parents.items()}


def _expand_with_parents(seed: set[str], parents: dict[str, list[str]]) -> set[str]:
    expanded = set(seed)
    stack = list(seed)
    while stack:
        uri = stack.pop()
        for p in parents.get(uri, ()):
            if p not in expanded:
                expanded.add(p)
                stack.append(p)
    return expanded


def _load_skills(rows: Iterable[dict[str, str]], allowed: set[str]) -> dict[str, dict]:
    skills: dict[str, dict] = {}
    for row in rows:
        uri = (row.get("conceptUri") or "").strip()
        if uri not in allowed:
            continue
        preferred = (row.get("preferredLabel") or "").strip()
        alt_labels = _parse_alt_labels(row.get("altLabels") or "", preferred)
        skills[uri] = {
            "uri": uri,
            "preferred_label": preferred,
            "alt_labels": alt_labels or None,
            "skill_type": (row.get("skillType") or "").strip() or None,
            "reuse_level": (row.get("reuseLevel") or "").strip() or None,
            "description": (row.get("description") or "").strip() or None,
        }
    return skills


def _dump_yaml(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        fh.write(ATTRIBUTION_HEADER)
        yaml.safe_dump(payload, fh, sort_keys=False, allow_unicode=True)
    size_kb = path.stat().st_size / 1024
    console.print(f"  wrote {path.relative_to(REPO_ROOT)}  ({size_kb:,.1f} KB)")


def main() -> None:
    _check_inputs()
    today = date.today().isoformat()
    console.rule("[bold]Preparing ESCO bundled data")

    progress_cols = (
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TextColumn("{task.completed}/{task.total}"),
        TimeElapsedColumn(),
    )

    with Progress(*progress_cols, console=console) as progress:
        task = progress.add_task("Loading ESCO CSVs", total=4)

        occupations = _filter_occupations(_read_csv(RAW_DIR / "occupations_en.csv"))
        progress.advance(task)

        occ_to_skills = _load_occupation_skill_relations(
            _read_csv(RAW_DIR / "occupationSkillRelations_en.csv"),
            occupation_uris=set(occupations),
        )
        progress.advance(task)

        skill_counter = _rank_skills(occ_to_skills)
        hierarchy = _load_skill_hierarchy(
            _read_csv(RAW_DIR / "broaderRelationsSkillPillar_en.csv")
        )
        progress.advance(task)

        top_skills = {uri for uri, _ in skill_counter.most_common(TARGET_SKILL_COUNT)}
        allowed = _expand_with_parents(top_skills, hierarchy)
        skills = _load_skills(_read_csv(RAW_DIR / "skills_en.csv"), allowed)
        progress.advance(task)

    skill_uris = set(skills)
    occ_to_skills_trimmed: dict[str, list[str]] = {}
    for occ_uri, linked in sorted(occ_to_skills.items()):
        kept = sorted(linked & skill_uris)
        if kept:
            occ_to_skills_trimmed[occ_uri] = kept

    hierarchy_trimmed: dict[str, list[str]] = {}
    for child in sorted(hierarchy):
        if child not in skill_uris:
            continue
        kept_parents = sorted(p for p in hierarchy[child] if p in skill_uris)
        if kept_parents:
            hierarchy_trimmed[child] = kept_parents

    occupation_rows = sorted(occupations.values(), key=lambda r: (r["isco_code"], r["uri"]))
    skill_rows = sorted(skills.values(), key=lambda r: r["uri"])

    console.print("\n[bold]Summary[/bold]")
    console.print(f"  occupations (ISCO 1-3):    {len(occupation_rows):,}")
    console.print(f"  skills (top + ancestors):  {len(skill_rows):,}")
    occ_skill_rows = sum(len(v) for v in occ_to_skills_trimmed.values())
    console.print(f"  occupation->skill rows:    {occ_skill_rows:,}")
    hierarchy_edges = sum(len(v) for v in hierarchy_trimmed.values())
    console.print(f"  hierarchy edges:           {hierarchy_edges:,}")

    header = {
        "version_date": today,
        "source": "ESCO v1.2.1 English CSV package (https://esco.ec.europa.eu)",
    }

    _dump_yaml(
        OUT_DIR / "esco-occupations.yml",
        {**header, "occupations": occupation_rows},
    )
    _dump_yaml(
        OUT_DIR / "esco-skills.yml",
        {**header, "skills": skill_rows},
    )
    _dump_yaml(
        OUT_DIR / "esco-occupation-skills.yml",
        {**header, "mapping": occ_to_skills_trimmed},
    )
    _dump_yaml(
        OUT_DIR / "esco-skill-hierarchy.yml",
        {**header, "parents": hierarchy_trimmed},
    )


if __name__ == "__main__":
    main()
