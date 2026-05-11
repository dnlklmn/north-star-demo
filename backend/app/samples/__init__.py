"""Pre-loaded sample skill projects shown as tiles on the New Skill Eval modal.

Each sample is a *fully populated North Star project for authoring a specific
SKILL.md*. Clicking a tile creates a session with:
  - skill metadata + body (the SKILL.md being authored)
  - extracted goals / users / stories (positive + off_target)
  - a complete charter (task / coverage / balance / alignment / rot / safety)
  - a starter dataset of labeled examples

No LLM call. Everything is hand-authored at build time so the user lands on a
known-good demo, not a coin-flip generation.

Adding a new sample
-------------------
1. Drop ``SKILL.md`` text into ``samples/skills/<id>.md``.
2. Add a module ``samples/_<id>.py`` exporting ``SAMPLE: Sample``.
3. Register the id in ``SAMPLE_IDS`` below.

Boot-time validation: every registered id is loaded and validated against
the Pydantic models. A broken fixture fails uvicorn startup rather than
producing a 500 on the first click.
"""

from __future__ import annotations

from functools import lru_cache
from importlib import import_module
from pathlib import Path
from typing import Optional

from pydantic import BaseModel, Field

from ..models import Charter, Example, SampleInfo


SAMPLES_DIR = Path(__file__).parent
SKILLS_DIR = SAMPLES_DIR / "skills"


# Order matters — this is the tile order on the modal. Keep tool-using
# samples first (they showcase the agent-mode capability), prose-only last.
SAMPLE_IDS: tuple[str, ...] = (
    "expense_reconciliation",
    "invoice_dispute",
    "investor_memo",
    "standup_notes",
)


class Sample(BaseModel):
    """A complete sample project — everything needed to instantiate a session.

    ``seed`` mirrors the shape ``call_skill_seed`` returns so the same
    ``_apply_seed_data`` helper that handles a real LLM-extracted payload
    can populate state from a hand-authored fixture.
    """

    id: str
    name: str  # tile heading
    blurb: str  # tile one-liner
    skill_name: str
    skill_description: str  # frontmatter description / routing signal
    # Resolved from samples/skills/<id>.md at module load time.
    skill_body: str
    seed: dict  # {task, goals, users, positive_stories, off_target_stories}
    charter: Charter
    examples: list[Example] = Field(default_factory=list)


def _load_skill_body(sample_id: str) -> str:
    path = SKILLS_DIR / f"{sample_id}.md"
    if not path.exists():
        raise FileNotFoundError(
            f"Sample '{sample_id}': missing SKILL.md at {path}"
        )
    return path.read_text(encoding="utf-8")


def _validate_examples(sample_id: str, examples: list[Example]) -> None:
    """Enforce invariants Pydantic alone can't catch."""
    for i, ex in enumerate(examples):
        # Example.expected_output is empty-allowed ONLY when should_trigger
        # is False (the skill should refuse to run). Any other combination
        # is a malformed row and we'd rather know at boot.
        if not ex.expected_output and ex.should_trigger is not False:
            raise ValueError(
                f"Sample '{sample_id}' example[{i}]: empty expected_output "
                "is only valid when should_trigger=False"
            )


def _load_sample(sample_id: str) -> Sample:
    """Import the sample module, attach the SKILL.md body, validate."""
    mod = import_module(f".{sample_id}", package=__name__)
    if not hasattr(mod, "build_sample"):
        raise AttributeError(
            f"Sample '{sample_id}': module is missing build_sample()"
        )
    sample: Sample = mod.build_sample(skill_body=_load_skill_body(sample_id))
    if sample.id != sample_id:
        raise ValueError(
            f"Sample id mismatch: module {sample_id!r} exported {sample.id!r}"
        )
    _validate_examples(sample_id, sample.examples)
    return sample


@lru_cache(maxsize=1)
def _registry() -> dict[str, Sample]:
    """Load every registered sample once. Cache keyed on nothing — fixtures
    are static. ``validate_all`` calls this at app startup so failures
    surface before the first request."""
    return {sid: _load_sample(sid) for sid in SAMPLE_IDS}


def validate_all() -> None:
    """Boot-time sanity pass. Raises if any fixture is malformed.

    Called from FastAPI's lifespan handler so a broken sample stops the
    server from coming up rather than producing a 500 on the user's click.
    """
    _registry()


def list_samples() -> list[SampleInfo]:
    """Tile-shaped projection of every registered sample, in SAMPLE_IDS order."""
    reg = _registry()
    return [
        SampleInfo(id=s.id, name=s.name, blurb=s.blurb)
        for s in (reg[sid] for sid in SAMPLE_IDS)
    ]


def load_sample(sample_id: str) -> Optional[Sample]:
    """Look up a sample by id; ``None`` for unknown ids so the endpoint
    can translate to a 404 instead of leaking an internal KeyError."""
    return _registry().get(sample_id)
