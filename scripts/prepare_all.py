"""Maintainer script: run every data preparation step in order.

Equivalent to running each of these in sequence:

    python scripts/prepare_esco.py
    python scripts/prepare_onet_crosswalk.py

The ESCO step must run first; the crosswalk step depends on
``src/career_planner/data/esco-occupations.yml`` existing.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

from rich.console import Console

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

STEPS: tuple[tuple[str, str], ...] = (
    ("prepare_esco", "ESCO taxonomy"),
    ("prepare_onet_crosswalk", "ESCO <-> O*NET crosswalk"),
)

console = Console()


def main() -> None:
    for module_name, label in STEPS:
        console.rule(f"[bold cyan]{label}")
        module = importlib.import_module(module_name)
        module.main()


if __name__ == "__main__":
    main()
