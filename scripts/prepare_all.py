"""Maintainer script: run every data preparation step in order.

Equivalent to running each of these in sequence:

    python scripts/prepare_esco.py
    python scripts/prepare_onet_crosswalk.py
    python scripts/prepare_jobhop_matrix.py

The ESCO step must run first; the other two depend on
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
    ("prepare_jobhop_matrix", "JobHop transition matrix"),
)

console = Console()


def main() -> None:
    for module_name, label in STEPS:
        console.rule(f"[bold cyan]{label}")
        module = importlib.import_module(module_name)
        # prepare_jobhop_matrix.main() takes an optional argv; pass [] so it
        # ignores prepare_all.py's own sys.argv when argparse runs.
        if module_name == "prepare_jobhop_matrix":
            module.main([])
        else:
            module.main()


if __name__ == "__main__":
    main()
