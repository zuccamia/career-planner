from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from . import WORKSPACE_MARKER

# Stable preferred order for the keys in the rendered ``llm:`` mapping.
# Anything in ``llm`` that isn't in this tuple is appended after, sorted.
_LLM_KEY_ORDER: tuple[str, ...] = (
    "provider",
    "base_url",
    "model",
    "api_key_env",
)


def save_llm_config(workspace: Path, llm: dict[str, Any]) -> None:
    """Replace (or append) the ``llm:`` mapping in ``config.yml``.

    Edits the file as text rather than re-serializing the whole document,
    so comments and other top-level sections (``language``, ``data``,
    ``mcp``, ``editor``, etc.) are preserved.

    ``llm`` is rendered in stable key order; values are passed through
    ``yaml.safe_dump`` so URLs, model IDs with colons, etc. are quoted
    correctly when needed.
    """
    path = workspace / WORKSPACE_MARKER
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    path.write_text(_replace_llm_block(text, llm), encoding="utf-8")


def _replace_llm_block(text: str, llm: dict[str, Any]) -> str:
    """Return ``text`` with its ``llm:`` mapping replaced or appended."""
    block = _render_llm_block(llm)
    lines = text.splitlines()

    start = None
    for i, line in enumerate(lines):
        # Top-level ``llm:`` line — no leading whitespace, ``llm:`` at column 0.
        if line.rstrip().startswith("llm:") and not line[:1].isspace():
            start = i
            break

    if start is None:
        prefix = text.rstrip("\n")
        if prefix:
            prefix += "\n\n"
        return prefix + block + "\n"

    # End of the block is the first subsequent line that starts in column 0
    # and is neither blank nor a comment — i.e. the next top-level YAML key.
    end = len(lines)
    for j in range(start + 1, len(lines)):
        line = lines[j]
        if not line.strip():
            continue
        if line[:1].isspace():
            continue
        if line.lstrip().startswith("#"):
            # A comment in column 0 belongs to the *following* section, so
            # stop here and keep that comment in place.
            end = j
            break
        end = j
        break

    # Trim trailing blank lines that were inside the old block, so the
    # spacing after the replacement matches what was there before.
    while end > start + 1 and not lines[end - 1].strip():
        end -= 1

    new_lines = lines[:start] + block.splitlines() + lines[end:]
    result = "\n".join(new_lines)
    if not result.endswith("\n"):
        result += "\n"
    return result


def _render_llm_block(llm: dict[str, Any]) -> str:
    """Render an ``llm`` config dict as a YAML mapping rooted at ``llm:``."""
    ordered: dict[str, Any] = {}
    for key in _LLM_KEY_ORDER:
        if key in llm and llm[key] not in (None, ""):
            ordered[key] = llm[key]
    for key in sorted(llm):
        if key in _LLM_KEY_ORDER:
            continue
        if llm[key] in (None, ""):
            continue
        ordered[key] = llm[key]

    rendered = yaml.safe_dump(
        {"llm": ordered}, default_flow_style=False, sort_keys=False
    )
    return rendered.rstrip("\n")