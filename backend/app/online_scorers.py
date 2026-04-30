"""Online scorer registry.

Online scorers are LLM-as-judge prompts that run on captured production traces
in Braintrust — see backend/app/scorers/*.md for the prompt sources of truth.

This module:
  - Loads each scorer .md file and parses its YAML frontmatter
  - Provides a CLI for inspecting / dry-running scorers locally
  - Acts as the registry the (future) Braintrust online-scorer push tool reads

The actual wiring of these prompts into Braintrust as autoeval scorers is a
one-time UI step — scorer prompts live in code so they're versioned, but the
Braintrust UI is where you attach trigger filters (e.g. ``turn_type =
"generate_draft"``) and sampling rates.

CLI usage:

    # List all scorers + their config
    python -m backend.app.online_scorers list

    # Print the full prompt body for one scorer (copy/paste into Braintrust UI)
    python -m backend.app.online_scorers show charter_quality

    # Dry-run a scorer against arbitrary {input, output} JSON via stdin —
    # useful for iterating on prompt text before pushing.
    echo '{"input": "...", "output": "..."}' | \\
        python -m backend.app.online_scorers test charter_quality
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# Anthropic-compatible client builder. Reused so online scorers honor the same
# model-routing flexibility as offline evals — Anthropic for high-stakes scorers,
# OpenRouter (Haiku, Gemini Flash, etc.) for cheaper ones.
from .eval_runner import _build_judge_client, make_judge


SCORERS_DIR = Path(__file__).parent / "scorers"

# Per-scorer model defaults — the doc's recommendation: Sonnet for charter
# quality (high stakes, low frequency), Haiku for the high-volume scorers.
# Override via env var named ``<UPPER_SCORER_NAME>_MODEL``.
DEFAULT_MODELS: dict[str, str] = {
    "charter_quality": "claude-sonnet-4-5-20250929",
    "goal_extraction_quality": "claude-haiku-4-5-20251001",
    "conversation_quality": "claude-haiku-4-5-20251001",
}


@dataclass
class ScorerSpec:
    """A scorer prompt file + its frontmatter config."""
    name: str
    path: Path
    body: str
    frontmatter: dict[str, Any]

    @property
    def description(self) -> str:
        return self.frontmatter.get("description", "")

    @property
    def turn_type(self) -> str | None:
        return self.frontmatter.get("turn_type")

    @property
    def phase(self) -> str | None:
        return self.frontmatter.get("phase")

    @property
    def phases(self) -> list[str]:
        val = self.frontmatter.get("phases")
        if isinstance(val, list):
            return val
        if isinstance(val, str):
            return [val]
        return []

    @property
    def sample_rate(self) -> float:
        val = self.frontmatter.get("sample_rate")
        try:
            return float(val) if val is not None else 1.0
        except (TypeError, ValueError):
            return 1.0

    def model(self) -> str:
        env_var = f"{self.name.upper()}_MODEL"
        return os.environ.get(env_var) or DEFAULT_MODELS.get(self.name, "claude-sonnet-4-5-20250929")

    def filter_expression(self) -> str:
        """A Braintrust filter clause that selects traces this scorer should run on.

        Use this string when configuring the online scorer's trigger in the
        Braintrust UI — it's the filter the scorer should match before firing.
        """
        clauses: list[str] = []
        if self.turn_type:
            clauses.append(f'metadata.turn_type = "{self.turn_type}"')
        if self.phase:
            clauses.append(f'metadata.phase = "{self.phase}"')
        elif self.phases:
            joined = ", ".join(f'"{p}"' for p in self.phases)
            clauses.append(f"metadata.phase IN ({joined})")
        return " AND ".join(clauses) if clauses else "(no filter — runs on every trace)"


def _parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """Parse a YAML-ish frontmatter block at the top of a markdown file.

    Kept dependency-free — we only need string keys and string/list values, so
    a small hand parser avoids pulling in PyYAML for this single use.
    """
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end < 0:
        return {}, text
    block = text[3:end].strip()
    body = text[end + 4:].lstrip("\n")

    fm: dict[str, Any] = {}
    current_list_key: str | None = None
    for line in block.splitlines():
        stripped = line.strip()
        if not stripped:
            current_list_key = None
            continue
        if stripped.startswith("- ") and current_list_key:
            fm[current_list_key].append(stripped[2:].strip().strip('"').strip("'"))
            continue
        if ":" not in stripped:
            current_list_key = None
            continue
        key, _, value = stripped.partition(":")
        key = key.strip()
        value = value.strip()
        if not value:
            # next lines are list items
            fm[key] = []
            current_list_key = key
            continue
        # Inline list: [a, b, c]
        if value.startswith("[") and value.endswith("]"):
            inner = value[1:-1]
            items = [v.strip().strip('"').strip("'") for v in inner.split(",") if v.strip()]
            fm[key] = items
        else:
            fm[key] = value.strip('"').strip("'")
        current_list_key = None
    return fm, body


def list_scorers() -> list[ScorerSpec]:
    """Discover all scorer .md files in the scorers/ directory."""
    if not SCORERS_DIR.exists():
        return []
    scorers: list[ScorerSpec] = []
    for path in sorted(SCORERS_DIR.glob("*.md")):
        text = path.read_text()
        fm, body = _parse_frontmatter(text)
        name = fm.get("name") or path.stem
        scorers.append(ScorerSpec(name=name, path=path, body=body, frontmatter=fm))
    return scorers


def get_scorer(name: str) -> ScorerSpec:
    for s in list_scorers():
        if s.name == name:
            return s
    raise SystemExit(f"No scorer named '{name}' in {SCORERS_DIR}")


def _build_scorer_prompt(spec: ScorerSpec, payload: dict[str, Any]) -> str:
    """Substitute {{input}} / {{output}} placeholders in the scorer body."""
    body = spec.body
    for key in ("input", "output", "expected"):
        placeholder = "{{" + key + "}}"
        if placeholder in body:
            value = payload.get(key, "")
            if isinstance(value, (dict, list)):
                value = json.dumps(value, indent=2)
            body = body.replace(placeholder, str(value))
    return body


def run_scorer(spec: ScorerSpec, payload: dict[str, Any]) -> dict[str, Any]:
    """Run the scorer prompt against a payload locally, return {score, response}."""
    api_key = os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise SystemExit("Need ANTHROPIC_API_KEY or OPENROUTER_API_KEY to dry-run a scorer.")
    model = spec.model()
    client = _build_judge_client(model, api_key)
    judge = make_judge(client, model)
    prompt = _build_scorer_prompt(spec, payload)
    score = judge(prompt)
    return {
        "scorer": spec.name,
        "model": model,
        "score": score,
        "response": getattr(judge, "last_response", None),
    }


def _print_list() -> None:
    scorers = list_scorers()
    if not scorers:
        print(f"No scorers found in {SCORERS_DIR}")
        return
    print(f"{len(scorers)} scorer(s) in {SCORERS_DIR}:\n")
    for s in scorers:
        print(f"• {s.name}")
        print(f"  description : {s.description}")
        print(f"  model       : {s.model()}")
        print(f"  filter      : {s.filter_expression()}")
        if s.sample_rate < 1.0:
            print(f"  sample rate : {s.sample_rate:.2f}")
        print(f"  source      : {s.path.relative_to(Path.cwd()) if s.path.is_relative_to(Path.cwd()) else s.path}")
        print()


def _print_show(name: str) -> None:
    spec = get_scorer(name)
    print(f"# {spec.name}")
    print(f"# description : {spec.description}")
    print(f"# model       : {spec.model()}")
    print(f"# filter      : {spec.filter_expression()}")
    if spec.sample_rate < 1.0:
        print(f"# sample rate : {spec.sample_rate:.2f}")
    print()
    print(spec.body)


def _run_test(name: str) -> None:
    spec = get_scorer(name)
    raw = sys.stdin.read().strip()
    if not raw:
        raise SystemExit('Pipe a JSON payload on stdin, e.g.: echo \'{"input":"...","output":"..."}\' | python -m backend.app.online_scorers test ' + name)
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as e:
        raise SystemExit(f"Invalid JSON on stdin: {e}")
    result = run_scorer(spec, payload)
    print(json.dumps(result, indent=2))


def _main() -> None:
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help", "help"):
        print(__doc__)
        return
    cmd = args[0]
    if cmd == "list":
        _print_list()
    elif cmd == "show":
        if len(args) < 2:
            raise SystemExit("usage: python -m backend.app.online_scorers show <name>")
        _print_show(args[1])
    elif cmd == "test":
        if len(args) < 2:
            raise SystemExit("usage: python -m backend.app.online_scorers test <name> < payload.json")
        _run_test(args[1])
    else:
        raise SystemExit(f"unknown command: {cmd}")


if __name__ == "__main__":
    _main()
