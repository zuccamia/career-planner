"""Tool registry for LLM function calling.

Defines the tool schemas exposed to the LLM and dispatches calls to
local handler functions.  Adding a new tool means adding an entry to
``TOOLS`` and a corresponding handler to ``_HANDLERS``.
"""

from __future__ import annotations

import json

from career_planner.core.taxonomy import search_skills_text

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search_esco_skills",
            "description": (
                "Search ESCO skills by name or description. "
                "Returns matching skill labels and URIs. Use this "
                "whenever you need to find the canonical ESCO entry "
                "for a skill, competence, or ability."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Skill name or keyword, e.g. 'project management', 'Python', 'teamwork'",
                    },
                },
                "required": ["query"],
            },
        },
    },
]

_HANDLERS = {
    "search_esco_skills": lambda args: json.dumps(
        [
            {"label": skill.preferred_label, "uri": skill.uri}
            for skill, _ in search_skills_text(args["query"], limit=5)
        ]
    ),
}


def dispatch(name: str, args: dict) -> str:
    """Execute a tool by name and return its JSON-encoded result.

    Raises :class:`ValueError` if the tool name is not registered.
    """
    import sys
    print(f"[tool] {name}({args})", file=sys.stderr)
    handler = _HANDLERS.get(name)
    if not handler:
        raise ValueError(f"Unknown tool: {name}")
    return handler(args)