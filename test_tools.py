from career_planner.core.llm.config import load_config
from career_planner.core.llm.client import complete_with_tools
from pathlib import Path

config = load_config(Path("."))  # run from your workspace

result = complete_with_tools(
    config,
    system=(
        "You help match job skills to ESCO taxonomy entries. "
        "Always use the search_esco_skills tool to look up skills."
    ),
    user="Find the ESCO entries for: Python, project management, Kubernetes",
)
print(result)
