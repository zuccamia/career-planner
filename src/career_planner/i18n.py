"""Internationalization helpers for career-planner.

All user-facing strings should be wrapped in `_()`. The active translation is
configured via `setup()` (typically by the CLI before any command runs). When
no translation is found for the requested language, gettext.NullTranslations
is used and strings are returned as-is.
"""

from __future__ import annotations

import gettext
import os
from pathlib import Path

DOMAIN = "career"
LOCALE_DIR = Path(__file__).parent / "locale"

_translation: gettext.NullTranslations = gettext.NullTranslations()


def setup(language: str | None = None) -> None:
    """Configure the active translation.

    Falls back to NullTranslations if no compiled catalog is found for the
    requested language — strings are returned unchanged in that case.
    """
    global _translation
    lang = language or os.environ.get("LANGUAGE", "en").split(":")[0] or "en"
    try:
        _translation = gettext.translation(
            DOMAIN, localedir=str(LOCALE_DIR), languages=[lang]
        )
    except FileNotFoundError:
        _translation = gettext.NullTranslations()


def _(message: str) -> str:
    """Translate `message` using the active translation."""
    return _translation.gettext(message)
