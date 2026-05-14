"""Shared value-coercion helpers.

These functions normalize "anything we read from YAML / JSON / a user
prompt" into a typed Python value. Centralized here so every reader uses
the same coercion rules — workspaces written by older versions of the
tool, or hand-edited frontmatter, all parse the same way.
"""

from __future__ import annotations

from datetime import date
from typing import Any


def coerce_date(value: Any) -> date | None:
    """Return a ``date`` for `value`, or ``None`` if it can't be parsed.

    Accepts a real ``date``, or an ISO-8601 prefix string (``YYYY-MM-DD``
    or anything with that prefix). Trailing time portions are dropped.
    """
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value.strip()[:10])
        except ValueError:
            return None
    return None


def coerce_int(value: Any, *, default: int) -> int:
    """Return an ``int`` for `value`, or `default` when it can't be parsed.

    Booleans never coerce to ``int`` (Python implicitly does, which would
    surface as silently treating ``True`` as ``1``). Floats are truncated.
    Numeric-looking strings are accepted after stripping.
    """
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return default
    return default


def coerce_str_tuple(value: Any) -> tuple[str, ...]:
    """Return a tuple of cleaned strings drawn from `value`.

    Drops non-string and empty entries. Each survivor is stripped of
    surrounding whitespace. Non-list inputs return an empty tuple — the
    function is total over arbitrary YAML/JSON input.
    """
    if not isinstance(value, list):
        return ()
    return tuple(
        str(item).strip()
        for item in value
        if str(item).strip()
    )
