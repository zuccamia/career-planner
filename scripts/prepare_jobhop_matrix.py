"""Maintainer script: HuggingFace JobHop -> transitions.yml.

Downloads the JobHop dataset (``aida-ugent/JobHop``) as parquet via
HuggingFace's parquet API, computes occupation-to-occupation transition
probabilities, and writes ``src/career_planner/data/transitions.yml``.

Each JobHop row is one career experience for a person:

    {
        "person_id": <int>,
        "matched_label": <str>,        # ESCO preferred label
        "matched_description": <str>,
        "matched_code": <str>,         # ESCO occupation code, e.g. "1324.8.3"
        "start_date": "Q1 2016",
        "end_date":   "Q2 2019",
        "university_studies": <bool>,
    }

We group rows by ``person_id``, sort each group by ``(start_date, end_date)``,
and count consecutive ``(matched_code_a -> matched_code_b)`` transitions where
``code_a != code_b``. Codes are then mapped to ESCO occupation URIs via the
curated ``esco-occupations.yml`` index; pairs whose endpoints are outside the
curated subset are dropped.

Only transitions with at least ``MIN_TRANSITION_COUNT`` occurrences are kept.

The output's ``version_date`` is stamped from the JobHop dataset's
``lastModified`` metadata (per the blueprint), with the local prep time
recorded separately as ``prepared_at``.

Run with: ``python scripts/prepare_jobhop_matrix.py [--max-rows N]``
"""

from __future__ import annotations

import argparse
import io
import re
import sys
from collections import Counter, defaultdict
from collections.abc import Iterator
from datetime import date
from pathlib import Path
from typing import Any

import httpx
import pyarrow.parquet as pq
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
OUT_DIR = REPO_ROOT / "src" / "career_planner" / "data"
OUT_FILE = OUT_DIR / "transitions.yml"

DATASET = "aida-ugent/JobHop"
CONFIG = "default"
SPLIT = "train"
BATCH_SIZE = 10_000
PARQUET_API = f"https://huggingface.co/api/datasets/{DATASET}/parquet"
DATASET_API = f"https://huggingface.co/api/datasets/{DATASET}"

MIN_TRANSITION_COUNT = 5

_QUARTER_RE = re.compile(r"^Q([1-4])\s+(\d{4})$")
_FAR_FUTURE = (9999, 9)

console = Console()


def _curated_code_to_uri() -> dict[str, str]:
    """Return {ESCO code -> ESCO URI} from the curated occupations YAML."""
    path = OUT_DIR / "esco-occupations.yml"
    if not path.is_file():
        console.print(
            f"[red]{path.relative_to(REPO_ROOT)} not found.[/red] "
            "Run scripts/prepare_esco.py first."
        )
        sys.exit(1)
    with path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    mapping: dict[str, str] = {}
    for row in data.get("occupations", []):
        code = (row.get("code") or "").strip()
        uri = (row.get("uri") or "").strip()
        if code and uri:
            mapping[code] = uri
    return mapping


def _parse_quarter(value: Any) -> tuple[int, int] | None:
    """Parse a 'Q<n> YYYY' string into a (year, quarter) sort tuple."""
    if not isinstance(value, str):
        return None
    m = _QUARTER_RE.match(value.strip())
    if not m:
        return None
    return (int(m.group(2)), int(m.group(1)))


def _fetch_dataset_updated_at(client: httpx.Client) -> str | None:
    try:
        resp = client.get(DATASET_API, timeout=30.0)
        resp.raise_for_status()
        return resp.json().get("lastModified")
    except httpx.HTTPError:
        return None


def _fetch_parquet_urls(client: httpx.Client) -> list[str]:
    resp = client.get(PARQUET_API, timeout=60.0)
    resp.raise_for_status()
    data = resp.json() or {}
    shards = (data.get(CONFIG) or {}).get(SPLIT) or []
    if not shards:
        console.print(
            f"[red]No parquet shards found for {DATASET} ({CONFIG}/{SPLIT}).[/red]\n"
            f"  endpoint: {PARQUET_API}"
        )
        sys.exit(1)
    return list(shards)


def _download(client: httpx.Client, url: str) -> bytes:
    with client.stream("GET", url, timeout=300.0, follow_redirects=True) as resp:
        resp.raise_for_status()
        total = int(resp.headers.get("content-length") or 0)
        chunks: list[bytes] = []
        with console.status(f"  downloading {url.rsplit('/', 1)[-1]}") as status:
            received = 0
            for chunk in resp.iter_bytes():
                chunks.append(chunk)
                received += len(chunk)
                if total:
                    pct = 100 * received / total
                    status.update(
                        f"  fetched {received:,}/{total:,} bytes ({pct:.1f}%)"
                    )
                else:
                    status.update(f"  fetched {received:,} bytes")
        return b"".join(chunks)


def _iter_rows(
    client: httpx.Client, max_rows: int | None
) -> Iterator[dict[str, Any]]:
    yielded = 0
    for url in _fetch_parquet_urls(client):
        data = _download(client, url)
        table = pq.read_table(io.BytesIO(data))
        for batch in table.to_batches(max_chunksize=BATCH_SIZE):
            for row in batch.to_pylist():
                if max_rows is not None and yielded >= max_rows:
                    return
                yield row
                yielded += 1


def _total_rows(client: httpx.Client) -> int | None:
    try:
        resp = client.get(
            "https://datasets-server.huggingface.co/info",
            params={"dataset": DATASET, "config": CONFIG},
            timeout=60.0,
        )
        resp.raise_for_status()
        info = resp.json().get("dataset_info") or {}
        splits = info.get("splits")
        if isinstance(splits, dict) and SPLIT in splits:
            return int(splits[SPLIT].get("num_examples") or 0) or None
    except (httpx.HTTPError, ValueError, TypeError):
        pass
    return None


def _collect_transitions(
    rows: Iterator[dict[str, Any]],
    code_to_uri: dict[str, str],
    progress: Progress,
    task_id: int,
) -> tuple[Counter[tuple[str, str]], int, int, int]:
    """Group rows by person, sort by quarter, and count consecutive transitions.

    Returns (counts_in_subset, rows_seen, raw_pairs, people_seen).
    """
    by_person: dict[int, list[tuple[tuple[int, int], tuple[int, int], str]]] = (
        defaultdict(list)
    )
    rows_seen = 0

    for row in rows:
        rows_seen += 1
        progress.advance(task_id)
        person_id = row.get("person_id")
        code = (row.get("matched_code") or "").strip()
        start = _parse_quarter(row.get("start_date"))
        if person_id is None or not code or start is None:
            continue
        end = _parse_quarter(row.get("end_date")) or _FAR_FUTURE
        by_person[person_id].append((start, end, code))

    counts: Counter[tuple[str, str]] = Counter()
    raw_pairs = 0
    for experiences in by_person.values():
        experiences.sort(key=lambda item: (item[0], item[1]))
        codes = [exp[2] for exp in experiences]
        for a, b in zip(codes, codes[1:]):
            if a == b:
                continue
            raw_pairs += 1
            uri_a = code_to_uri.get(a)
            uri_b = code_to_uri.get(b)
            if uri_a and uri_b:
                counts[(uri_a, uri_b)] += 1

    return counts, rows_seen, raw_pairs, len(by_person)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--max-rows",
        type=int,
        default=None,
        help="Cap rows fetched (useful for dry runs).",
    )
    args = parser.parse_args(argv)

    today = date.today().isoformat()
    console.rule("[bold]Preparing JobHop transition matrix")

    code_to_uri = _curated_code_to_uri()
    console.print(f"Curated ESCO occupations: {len(code_to_uri):,}")

    with httpx.Client(headers={"Accept": "application/json"}) as client:
        updated_at = _fetch_dataset_updated_at(client)
        total = _total_rows(client)
        if args.max_rows is not None:
            total = min(total or args.max_rows, args.max_rows)

        progress_cols = (
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TextColumn(
                "{task.completed:,}/{task.total:,}"
                if total
                else "{task.completed:,} rows"
            ),
            TimeElapsedColumn(),
        )
        with Progress(*progress_cols, console=console) as progress:
            task_id = progress.add_task("Fetching JobHop rows", total=total)
            counts, rows_seen, raw_pairs, people = _collect_transitions(
                _iter_rows(client, args.max_rows),
                code_to_uri,
                progress,
                task_id,
            )

    if not counts:
        console.print(
            "[red]No transitions extracted.[/red] The JobHop schema may have "
            "changed — inspect a sample row at\n"
            f"  {ROWS_URL}?dataset={DATASET}&config={CONFIG}&split={SPLIT}"
            "&offset=0&length=1\n"
            "and adjust this script."
        )
        sys.exit(1)

    filtered = {pair: c for pair, c in counts.items() if c >= MIN_TRANSITION_COUNT}
    in_subset = sum(counts.values())
    console.print(
        f"People: {people:,} | rows: {rows_seen:,} | raw pairs: {raw_pairs:,} | "
        f"in subset: {in_subset:,} | >={MIN_TRANSITION_COUNT}: {len(filtered):,}"
    )

    grouped: dict[str, list[tuple[str, int]]] = defaultdict(list)
    for (a, b), c in filtered.items():
        grouped[a].append((b, c))

    matrix: dict[str, list[dict[str, Any]]] = {}
    for from_uri in sorted(grouped):
        pairs = sorted(grouped[from_uri], key=lambda p: (-p[1], p[0]))
        total_count = sum(c for _, c in pairs)
        matrix[from_uri] = [
            {
                "to_occupation": to,
                "count": c,
                "probability": round(c / total_count, 6),
            }
            for to, c in pairs
        ]

    payload = {
        "version_date": updated_at or today,
        "prepared_at": today,
        "source_dataset": DATASET,
        "min_transition_count": MIN_TRANSITION_COUNT,
        "transitions": matrix,
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with OUT_FILE.open("w", encoding="utf-8") as fh:
        yaml.safe_dump(payload, fh, sort_keys=False, allow_unicode=True)

    size_kb = OUT_FILE.stat().st_size / 1024
    console.print(f"  wrote {OUT_FILE.relative_to(REPO_ROOT)}  ({size_kb:,.1f} KB)")


if __name__ == "__main__":
    main()
