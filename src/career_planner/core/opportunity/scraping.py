"""SPA detection and dynamic-page scraping for job postings.

When a plain ``httpx.get`` returns a JavaScript shell with little readable
content, the helpers here detect that and optionally re-fetch the page
through Firecrawl's scrape + interact workflow so the downstream extractors
receive the fully-rendered text.

Environment
-----------
``FIRECRAWL_API_KEY``
    Required for :func:`scrape_dynamic_page`. When unset the function raises
    ``RuntimeError`` so callers can fall back to the raw HTML gracefully.
"""

from __future__ import annotations

import os
import re

from rich.console import Console

from .inference import html_to_text

console = Console(stderr=True)

# ---- SPA detection --------------------------------------------------------

# Common SPA root containers that are empty before JS executes.
_SPA_ROOT_RE = re.compile(
    r'<div\s+id=["\'](?:root|app|__next)["\']>\s*</div>',
    re.IGNORECASE,
)

# Minimum word count in the stripped text for a page to be considered
# "content-rich" (i.e. not a hollow SPA shell).
_MIN_WORD_COUNT = 50


def looks_like_spa_shell(html_text: str) -> bool:
    """Return True if *html_text* appears to be a JS SPA with little real content.

    The heuristic checks two things:
    1. Whether the tag-stripped text has fewer than ``_MIN_WORD_COUNT`` words.
    2. Whether the HTML contains an empty root ``<div>`` typical of React /
       Next.js / Vue apps.

    Either condition is enough to trigger a headless re-fetch.
    """
    if not html_text:
        return True
    text = html_to_text(html_text)
    if len(text.split()) < _MIN_WORD_COUNT:
        return True
    if _SPA_ROOT_RE.search(html_text):
        return True
    return False


# ---- Firecrawl scraping ---------------------------------------------------


def scrape_dynamic_page(url: str) -> str:
    """Scrape a JS-rendered page via Firecrawl, expanding hidden content.

    Steps:
    1. ``scrape`` — renders the page and returns markdown + a session id.
    2. ``interact`` — clicks any "More" / "Show more" expanders so hidden
       content is revealed.
    3. ``interact`` — re-extracts the now-complete page as markdown.

    Returns clean markdown text suitable for direct LLM consumption or
    for the regex-based extractors after minimal post-processing.

    Raises
    ------
    RuntimeError
        If ``FIRECRAWL_API_KEY`` is not set.
    ValueError
        If Firecrawl returns no usable content.
    """
    import warnings
    warnings.filterwarnings("ignore", message="Field name.*shadows an attribute")
    from firecrawl import Firecrawl

    api_key = os.environ.get("FIRECRAWL_API_KEY")
    if not api_key:
        raise RuntimeError("FIRECRAWL_API_KEY is not set")

    app = Firecrawl(api_key=api_key)

    # 1. Initial scrape ─ renders JS and returns markdown.
    with console.status("Rendering page in headless browser…"):
        result = app.scrape(url, formats=["markdown"])
    scrape_id = result.metadata.scrape_id
    initial_markdown = result.markdown or ""
    console.print(
        f"Firecrawl: initial scrape returned {len(initial_markdown)} chars from {url}",
    )

    # 2. Interact ─ expand collapsed sections.
    expanded_markdown = ""
    try:
        with console.status("Expanding hidden content…"):
            app.interact(
                scrape_id,
                prompt=(
                    "Click all 'More', 'Show more', 'See more', 'Read more', "
                    "or 'Load more' buttons on the page and wait for the "
                    "content to fully load."
                ),
            )

        # 3. Re-extract now that the DOM is fully expanded.
        with console.status("Extracting full page content…"):
            response = app.interact(
                scrape_id,
                prompt="Extract the complete page content as markdown.",
            )
        expanded_markdown = response.output or ""
        console.print(
            f"Firecrawl: expanded scrape returned {len(expanded_markdown)} chars from {url}",
        )
    except Exception as exc:
        console.print(
            f"[yellow]Firecrawl interact failed: {exc}; using initial scrape[/yellow]",
        )
    finally:
        try:
            app.stop_interaction(scrape_id)
        except Exception:
            pass

    # Prefer the expanded version; fall back to the initial scrape.
    markdown = expanded_markdown if expanded_markdown else initial_markdown
    if not markdown:
        raise ValueError(f"Firecrawl returned no content for {url}")

    return markdown