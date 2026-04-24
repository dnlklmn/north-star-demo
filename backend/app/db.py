"""Database connection and queries for sessions and charters."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

import asyncpg

_pool: asyncpg.Pool | None = None


async def init_db(database_url: str) -> None:
    global _pool
    _pool = await asyncpg.create_pool(database_url)
    await _create_tables()


async def close_db() -> None:
    global _pool
    if _pool:
        await _pool.close()
        _pool = None


async def get_pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("Database not initialised — call init_db() first")
    return _pool


async def _create_tables() -> None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                id              TEXT PRIMARY KEY,
                name            TEXT,
                created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
                agent_status    TEXT NOT NULL DEFAULT 'drafting',
                state           JSONB NOT NULL DEFAULT '{}'::jsonb,
                conversation    JSONB NOT NULL DEFAULT '[]'::jsonb
            );
        """)
        # Migrate: add name and updated_at columns if missing
        await conn.execute("""
            DO $$ BEGIN
                ALTER TABLE sessions ADD COLUMN IF NOT EXISTS name TEXT;
                ALTER TABLE sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
            EXCEPTION WHEN others THEN NULL;
            END $$;
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS charters (
                id              TEXT PRIMARY KEY,
                session_id      TEXT NOT NULL REFERENCES sessions(id),
                created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
                finalised_at    TIMESTAMPTZ,
                charter         JSONB NOT NULL DEFAULT '{}'::jsonb,
                weak_criteria   JSONB NOT NULL DEFAULT '[]'::jsonb
            );
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS turns (
                id              TEXT PRIMARY KEY,
                session_id      TEXT NOT NULL REFERENCES sessions(id),
                created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
                turn_type       TEXT NOT NULL,
                input_snapshot  JSONB NOT NULL,
                llm_calls       JSONB NOT NULL DEFAULT '[]'::jsonb,
                parsed_output   JSONB,
                agent_message   TEXT,
                suggestions     JSONB
            );
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS judgements (
                id              TEXT PRIMARY KEY,
                turn_id         TEXT NOT NULL REFERENCES turns(id),
                created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
                judge_model     TEXT NOT NULL,
                judge_prompt    TEXT NOT NULL,
                scores          JSONB NOT NULL,
                reasoning       TEXT
            );
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS datasets (
                id                TEXT PRIMARY KEY,
                session_id        TEXT NOT NULL REFERENCES sessions(id),
                version           INTEGER NOT NULL DEFAULT 1,
                parent_version_id TEXT REFERENCES datasets(id),
                name              TEXT,
                status            TEXT NOT NULL DEFAULT 'draft',
                stats             JSONB NOT NULL DEFAULT '{}'::jsonb,
                charter_snapshot  JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
            );
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS examples (
                id              TEXT PRIMARY KEY,
                dataset_id      TEXT NOT NULL REFERENCES datasets(id),
                feature_area    TEXT NOT NULL,
                input           TEXT NOT NULL,
                expected_output TEXT NOT NULL,
                coverage_tags   JSONB NOT NULL DEFAULT '[]'::jsonb,
                source          TEXT NOT NULL DEFAULT 'manual',
                label           TEXT NOT NULL DEFAULT 'unlabeled',
                label_reason    TEXT,
                review_status   TEXT NOT NULL DEFAULT 'pending',
                reviewer_notes  TEXT,
                judge_verdict   JSONB,
                created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
            );
        """)
        await conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_examples_dataset ON examples(dataset_id);
        """)
        await conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_examples_review ON examples(dataset_id, review_status);
        """)
        await conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_examples_feature ON examples(dataset_id, feature_area);
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                id              TEXT PRIMARY KEY DEFAULT 'default',
                model_name      TEXT NOT NULL DEFAULT 'claude-sonnet-4-20250514',
                max_rounds      INTEGER NOT NULL DEFAULT 3,
                creativity       REAL NOT NULL DEFAULT 0.2,
                updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
            );
        """)
        # Ensure default settings row exists
        await conn.execute("""
            INSERT INTO settings (id) VALUES ('default') ON CONFLICT (id) DO NOTHING;
        """)
        # Migration: add revision_suggestion column to examples
        await conn.execute("""
            ALTER TABLE examples ADD COLUMN IF NOT EXISTS revision_suggestion JSONB;
        """)
        # Migration: add should_trigger column for triggered-mode (skill) evals.
        # NULL = standard mode / no routing decision modeled.
        await conn.execute("""
            ALTER TABLE examples ADD COLUMN IF NOT EXISTS should_trigger BOOLEAN;
        """)
        # Migration: is_adversarial marks safety-probe rows (prompt injection,
        # exfiltration attempts, etc). Safety scorers weight these heavily.
        await conn.execute("""
            ALTER TABLE examples ADD COLUMN IF NOT EXISTS is_adversarial BOOLEAN;
        """)
        # Relax expected_output — empty string required for should_trigger=false rows.
        await conn.execute("""
            ALTER TABLE examples ALTER COLUMN expected_output DROP NOT NULL;
        """)

        # eval_runs: persisted Braintrust execution-eval runs. Previously lived
        # in an in-memory dict, so runs were lost on server restart. Now each
        # run is a row so history survives and the Improve tab can always find
        # the run it was asked to analyze.
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS eval_runs (
                id                      TEXT PRIMARY KEY,
                session_id              TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                status                  TEXT NOT NULL DEFAULT 'pending',
                project                 TEXT NOT NULL,
                experiment_name         TEXT,
                experiment_url          TEXT,
                rows_total              INTEGER NOT NULL DEFAULT 0,
                rows_evaluated          INTEGER NOT NULL DEFAULT 0,
                scorer_names            JSONB NOT NULL DEFAULT '[]'::jsonb,
                scorer_averages         JSONB NOT NULL DEFAULT '{}'::jsonb,
                per_row                 JSONB NOT NULL DEFAULT '[]'::jsonb,
                error                   TEXT,
                skill_version_id        TEXT,
                skill_version_number    INTEGER,
                started_at              TIMESTAMPTZ,
                finished_at             TIMESTAMPTZ,
                created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
            );
        """)
        await conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_eval_runs_session
                ON eval_runs(session_id, created_at DESC);
        """)
        # Migration: capture the charter at run-creation time so the UI can
        # show exactly what was evaluated, even after later edits.
        await conn.execute("""
            ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS charter_snapshot JSONB;
        """)
        # Migration: persist the suggestions generated by analyzing this run
        # so they survive page reload. Each suggestion carries its generated
        # state; accept/dismiss state is client-side and resets on reload.
        await conn.execute("""
            ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS improvement_suggestions JSONB;
        """)
        await conn.execute("""
            ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS improvement_summary TEXT;
        """)


# --- Session CRUD ---

async def create_session(session_id: str, state: dict, name: str | None = None) -> dict:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO sessions (id, name, agent_status, state, conversation)
            VALUES ($1, $2, $3, $4, $5::jsonb)
            RETURNING id, name, created_at, updated_at, agent_status, state, conversation
            """,
            session_id,
            name,
            state.get("agent_status", "drafting"),
            json.dumps(state),
            json.dumps([]),
        )
        return dict(row)


async def get_session(session_id: str) -> dict | None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, name, created_at, updated_at, agent_status, state, conversation FROM sessions WHERE id = $1",
            session_id,
        )
        if row is None:
            return None
        result = dict(row)
        # asyncpg returns jsonb as strings or dicts depending on version
        if isinstance(result["state"], str):
            result["state"] = json.loads(result["state"])
        if isinstance(result["conversation"], str):
            result["conversation"] = json.loads(result["conversation"])
        return result


async def update_session(session_id: str, state: dict, conversation: list[dict]) -> dict:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE sessions
            SET agent_status = $2, state = $3, conversation = $4::jsonb,
                updated_at = now()
            WHERE id = $1
            RETURNING id, name, created_at, updated_at, agent_status, state, conversation
            """,
            session_id,
            state.get("agent_status", "drafting"),
            json.dumps(state),
            json.dumps(conversation),
        )
        if row is None:
            raise ValueError(f"Session {session_id} not found")
        result = dict(row)
        if isinstance(result["state"], str):
            result["state"] = json.loads(result["state"])
        if isinstance(result["conversation"], str):
            result["conversation"] = json.loads(result["conversation"])
        return result


async def list_sessions(limit: int = 50) -> list[dict]:
    """List sessions ordered by most recently updated, returning summary info."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT s.id, s.name, s.created_at, s.updated_at, s.agent_status, s.state,
                   EXISTS(SELECT 1 FROM datasets d WHERE d.session_id = s.id) AS has_dataset
            FROM sessions s
            ORDER BY s.updated_at DESC
            LIMIT $1
            """,
            limit,
        )
        results = []
        for r in rows:
            row = dict(r)
            state = row.get("state")
            if isinstance(state, str):
                state = json.loads(state)
            # Compute has_charter from state
            charter = (state or {}).get("charter", {})
            has_charter = bool(
                charter.get("coverage", {}).get("criteria")
                or charter.get("alignment")
            )
            row["has_charter"] = has_charter
            results.append(row)
        return results


async def delete_session(session_id: str) -> None:
    """Delete a session and all associated data (cascading)."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        # Delete in dependency order
        await conn.execute(
            "DELETE FROM examples WHERE dataset_id IN (SELECT id FROM datasets WHERE session_id = $1)",
            session_id,
        )
        await conn.execute(
            "DELETE FROM judgements WHERE turn_id IN (SELECT id FROM turns WHERE session_id = $1)",
            session_id,
        )
        await conn.execute("DELETE FROM datasets WHERE session_id = $1", session_id)
        await conn.execute("DELETE FROM turns WHERE session_id = $1", session_id)
        await conn.execute("DELETE FROM charters WHERE session_id = $1", session_id)
        result = await conn.execute("DELETE FROM sessions WHERE id = $1", session_id)
        if result == "DELETE 0":
            raise ValueError(f"Session {session_id} not found")


async def update_session_name(session_id: str, name: str) -> dict:
    """Rename a session."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE sessions
            SET name = $2, updated_at = now()
            WHERE id = $1
            RETURNING id, name, created_at, updated_at, agent_status
            """,
            session_id,
            name,
        )
        if row is None:
            raise ValueError(f"Session {session_id} not found")
        return dict(row)


async def update_session_input(session_id: str, state: dict) -> dict:
    """Save updated input (goals/stories) without running agent — just persist state."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE sessions
            SET state = $2, updated_at = now()
            WHERE id = $1
            RETURNING id, name, created_at, updated_at, agent_status, state, conversation
            """,
            session_id,
            json.dumps(state),
        )
        if row is None:
            raise ValueError(f"Session {session_id} not found")
        result = dict(row)
        if isinstance(result["state"], str):
            result["state"] = json.loads(result["state"])
        if isinstance(result["conversation"], str):
            result["conversation"] = json.loads(result["conversation"])
        return result


# --- Charter CRUD ---

async def create_charter(session_id: str, charter: dict, weak_criteria: list[dict] | None = None) -> dict:
    pool = await get_pool()
    charter_id = str(uuid.uuid4())
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO charters (id, session_id, charter, weak_criteria)
            VALUES ($1, $2, $3, $4::jsonb)
            RETURNING id, session_id, created_at, finalised_at, charter, weak_criteria
            """,
            charter_id,
            session_id,
            json.dumps(charter),
            json.dumps(weak_criteria or []),
        )
        result = dict(row)
        if isinstance(result["charter"], str):
            result["charter"] = json.loads(result["charter"])
        if isinstance(result["weak_criteria"], str):
            result["weak_criteria"] = json.loads(result["weak_criteria"])
        return result


async def finalize_charter(charter_id: str) -> dict:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE charters SET finalised_at = $2
            WHERE id = $1
            RETURNING id, session_id, created_at, finalised_at, charter, weak_criteria
            """,
            charter_id,
            datetime.now(timezone.utc),
        )
        if row is None:
            raise ValueError(f"Charter {charter_id} not found")
        result = dict(row)
        if isinstance(result["charter"], str):
            result["charter"] = json.loads(result["charter"])
        if isinstance(result["weak_criteria"], str):
            result["weak_criteria"] = json.loads(result["weak_criteria"])
        return result


# --- Turn CRUD ---

async def create_turn(
    session_id: str,
    turn_type: str,
    input_snapshot: dict,
    llm_calls: list[dict],
    parsed_output: dict | None = None,
    agent_message: str | None = None,
    suggestions: dict | None = None,
) -> dict:
    pool = await get_pool()
    turn_id = str(uuid.uuid4())
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO turns (id, session_id, turn_type, input_snapshot, llm_calls, parsed_output, agent_message, suggestions)
            VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
            RETURNING id, session_id, created_at, turn_type, input_snapshot, llm_calls, parsed_output, agent_message, suggestions
            """,
            turn_id,
            session_id,
            turn_type,
            json.dumps(input_snapshot),
            json.dumps(llm_calls),
            json.dumps(parsed_output) if parsed_output is not None else None,
            agent_message,
            json.dumps(suggestions) if suggestions is not None else None,
        )
        return _parse_turn_row(row)


async def get_turns(session_id: str) -> list[dict]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT * FROM turns WHERE session_id = $1 ORDER BY created_at",
            session_id,
        )
        return [_parse_turn_row(r) for r in rows]


async def get_activity(
    session_id: str,
    after: datetime | None = None,
    limit: int = 50,
) -> list[dict]:
    """Turn list for the Polaris activity feed: id, created_at, turn_type, parsed_output."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        if after is not None:
            rows = await conn.fetch(
                """
                SELECT id, created_at, turn_type, parsed_output
                FROM turns
                WHERE session_id = $1 AND created_at > $2
                ORDER BY created_at ASC
                LIMIT $3
                """,
                session_id, after, limit,
            )
        else:
            rows = await conn.fetch(
                """
                SELECT id, created_at, turn_type, parsed_output
                FROM turns
                WHERE session_id = $1
                ORDER BY created_at DESC
                LIMIT $2
                """,
                session_id, limit,
            )
            # Oldest first for consistent ordering on the client
            rows = list(reversed(rows))
        results = []
        for r in rows:
            d = dict(r)
            if isinstance(d.get("parsed_output"), str):
                d["parsed_output"] = json.loads(d["parsed_output"])
            results.append(d)
        return results


async def get_unjudged_turns(session_id: str | None = None) -> list[dict]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        if session_id:
            rows = await conn.fetch(
                """
                SELECT t.* FROM turns t
                LEFT JOIN judgements j ON j.turn_id = t.id
                WHERE j.id IS NULL AND t.session_id = $1
                ORDER BY t.created_at
                """,
                session_id,
            )
        else:
            rows = await conn.fetch(
                """
                SELECT t.* FROM turns t
                LEFT JOIN judgements j ON j.turn_id = t.id
                WHERE j.id IS NULL
                ORDER BY t.created_at
                """,
            )
        return [_parse_turn_row(r) for r in rows]


def _parse_turn_row(row) -> dict:
    result = dict(row)
    for key in ("input_snapshot", "llm_calls", "parsed_output", "suggestions"):
        if key in result and isinstance(result[key], str):
            result[key] = json.loads(result[key])
    return result


# --- Judgement CRUD ---

async def create_judgement(
    turn_id: str,
    judge_model: str,
    judge_prompt: str,
    scores: dict,
    reasoning: str | None = None,
) -> dict:
    pool = await get_pool()
    judgement_id = str(uuid.uuid4())
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO judgements (id, turn_id, judge_model, judge_prompt, scores, reasoning)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id, turn_id, created_at, judge_model, judge_prompt, scores, reasoning
            """,
            judgement_id,
            turn_id,
            judge_model,
            judge_prompt,
            json.dumps(scores),
            reasoning,
        )
        result = dict(row)
        if isinstance(result.get("scores"), str):
            result["scores"] = json.loads(result["scores"])
        return result


# --- Dataset CRUD ---

async def create_dataset(session_id: str, name: str, charter_snapshot: dict) -> dict:
    pool = await get_pool()
    dataset_id = str(uuid.uuid4())
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO datasets (id, session_id, name, charter_snapshot)
            VALUES ($1, $2, $3, $4)
            RETURNING *
            """,
            dataset_id, session_id, name, json.dumps(charter_snapshot),
        )
        return _parse_dataset_row(row)


async def get_dataset(dataset_id: str) -> dict | None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM datasets WHERE id = $1", dataset_id)
        if row is None:
            return None
        return _parse_dataset_row(row)


async def get_dataset_by_session(session_id: str) -> dict | None:
    """Get the latest (highest version) dataset for a session."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM datasets WHERE session_id = $1 ORDER BY version DESC LIMIT 1",
            session_id,
        )
        if row is None:
            return None
        return _parse_dataset_row(row)


async def get_dataset_versions(session_id: str) -> list[dict]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT * FROM datasets WHERE session_id = $1 ORDER BY version",
            session_id,
        )
        return [_parse_dataset_row(r) for r in rows]


async def create_dataset_version(dataset_id: str, charter_snapshot: dict) -> dict:
    """Create a new version by copying all examples from the current dataset."""
    pool = await get_pool()
    current = await get_dataset(dataset_id)
    if current is None:
        raise ValueError(f"Dataset {dataset_id} not found")

    new_id = str(uuid.uuid4())
    new_version = current["version"] + 1

    async with pool.acquire() as conn:
        # Create new dataset version
        row = await conn.fetchrow(
            """
            INSERT INTO datasets (id, session_id, version, parent_version_id, name, status, charter_snapshot)
            VALUES ($1, $2, $3, $4, $5, 'draft', $6)
            RETURNING *
            """,
            new_id, current["session_id"], new_version, dataset_id,
            current["name"], json.dumps(charter_snapshot),
        )

        # Copy examples
        examples = await get_examples(dataset_id)
        for ex in examples:
            await conn.execute(
                """
                INSERT INTO examples (id, dataset_id, feature_area, input, expected_output,
                    coverage_tags, source, label, label_reason, review_status, reviewer_notes, judge_verdict)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                """,
                str(uuid.uuid4()), new_id, ex["feature_area"], ex["input"], ex["expected_output"],
                json.dumps(ex.get("coverage_tags", [])), ex["source"], ex["label"],
                ex.get("label_reason"), ex["review_status"], ex.get("reviewer_notes"),
                json.dumps(ex.get("judge_verdict")) if ex.get("judge_verdict") else None,
            )

        return _parse_dataset_row(row)


async def update_dataset_stats(dataset_id: str) -> dict:
    """Recompute and update cached stats for a dataset."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        examples = await get_examples(dataset_id)

        by_review = {"pending": 0, "approved": 0, "rejected": 0, "needs_edit": 0}
        by_label = {"good": 0, "bad": 0, "unlabeled": 0}
        by_feature: dict[str, int] = {}

        for ex in examples:
            rs = ex["review_status"]
            if rs in by_review:
                by_review[rs] += 1
            lbl = ex["label"]
            if lbl in by_label:
                by_label[lbl] += 1
            fa = ex["feature_area"]
            by_feature[fa] = by_feature.get(fa, 0) + 1

        stats = {
            "total": len(examples),
            "by_review_status": by_review,
            "by_label": by_label,
            "by_feature_area": by_feature,
        }

        await conn.execute(
            "UPDATE datasets SET stats = $1 WHERE id = $2",
            json.dumps(stats), dataset_id,
        )
        return stats


def _parse_dataset_row(row) -> dict:
    result = dict(row)
    for key in ("stats", "charter_snapshot"):
        if key in result and isinstance(result[key], str):
            result[key] = json.loads(result[key])
    return result


# --- Example CRUD ---

async def create_example(
    dataset_id: str,
    feature_area: str,
    input_text: str,
    expected_output: str,
    coverage_tags: list[str] | None = None,
    source: str = "manual",
    label: str = "unlabeled",
    label_reason: str | None = None,
    should_trigger: bool | None = None,
    is_adversarial: bool | None = None,
) -> dict:
    pool = await get_pool()
    example_id = str(uuid.uuid4())
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO examples (id, dataset_id, feature_area, input, expected_output,
                coverage_tags, source, label, label_reason, should_trigger, is_adversarial)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING *
            """,
            example_id, dataset_id, feature_area, input_text, expected_output,
            json.dumps(coverage_tags or []), source, label, label_reason,
            should_trigger, is_adversarial,
        )
        return _parse_example_row(row)


async def bulk_create_examples(dataset_id: str, examples: list[dict]) -> list[dict]:
    pool = await get_pool()
    results = []
    async with pool.acquire() as conn:
        for ex in examples:
            row = await conn.fetchrow(
                """
                INSERT INTO examples (id, dataset_id, feature_area, input, expected_output,
                    coverage_tags, source, label, label_reason, should_trigger, is_adversarial)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                RETURNING *
                """,
                str(uuid.uuid4()), dataset_id, ex["feature_area"], ex["input"],
                ex.get("expected_output", "") or "",
                json.dumps(ex.get("coverage_tags", [])), ex.get("source", "manual"),
                ex.get("label", "unlabeled"), ex.get("label_reason"),
                ex.get("should_trigger"),
                ex.get("is_adversarial"),
            )
            results.append(_parse_example_row(row))
    return results


async def get_examples(
    dataset_id: str,
    feature_area: str | None = None,
    label: str | None = None,
    review_status: str | None = None,
    source: str | None = None,
) -> list[dict]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        query = "SELECT * FROM examples WHERE dataset_id = $1"
        params: list = [dataset_id]
        idx = 2

        if feature_area:
            query += f" AND feature_area = ${idx}"
            params.append(feature_area)
            idx += 1
        if label:
            query += f" AND label = ${idx}"
            params.append(label)
            idx += 1
        if review_status:
            query += f" AND review_status = ${idx}"
            params.append(review_status)
            idx += 1
        if source:
            query += f" AND source = ${idx}"
            params.append(source)
            idx += 1

        query += " ORDER BY created_at"
        rows = await conn.fetch(query, *params)
        return [_parse_example_row(r) for r in rows]


async def update_example(example_id: str, fields: dict) -> dict:
    pool = await get_pool()
    allowed = {"feature_area", "input", "expected_output", "coverage_tags", "label",
               "label_reason", "review_status", "reviewer_notes", "judge_verdict",
               "revision_suggestion", "should_trigger", "is_adversarial"}
    updates = {k: v for k, v in fields.items() if k in allowed}
    if not updates:
        raise ValueError("No valid fields to update")

    # Serialize JSON fields
    for key in ("coverage_tags", "judge_verdict", "revision_suggestion"):
        if key in updates and not isinstance(updates[key], str):
            updates[key] = json.dumps(updates[key])

    set_parts = []
    params = []
    idx = 1
    for key, val in updates.items():
        set_parts.append(f"{key} = ${idx}")
        params.append(val)
        idx += 1
    set_parts.append(f"updated_at = ${idx}")
    params.append(datetime.now(timezone.utc))
    idx += 1
    params.append(example_id)

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            f"UPDATE examples SET {', '.join(set_parts)} WHERE id = ${idx} RETURNING *",
            *params,
        )
        if row is None:
            raise ValueError(f"Example {example_id} not found")
        return _parse_example_row(row)


async def delete_example(example_id: str) -> bool:
    pool = await get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute("DELETE FROM examples WHERE id = $1", example_id)
        return result == "DELETE 1"


async def export_dataset(dataset_id: str) -> dict:
    """Export all approved examples as a structured dict."""
    dataset = await get_dataset(dataset_id)
    if dataset is None:
        raise ValueError(f"Dataset {dataset_id} not found")

    examples = await get_examples(dataset_id, review_status="approved")

    return {
        "dataset_id": dataset_id,
        "session_id": dataset["session_id"],
        "version": dataset["version"],
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "examples": [
            {
                "id": ex["id"],
                "feature_area": ex["feature_area"],
                "input": ex["input"],
                "expected_output": ex["expected_output"],
                "coverage_tags": ex.get("coverage_tags", []),
                "label": ex["label"],
                "label_reason": ex.get("label_reason"),
            }
            for ex in examples
        ],
    }


def _parse_example_row(row) -> dict:
    result = dict(row)
    for key in ("coverage_tags", "judge_verdict", "revision_suggestion"):
        if key in result and isinstance(result[key], str):
            result[key] = json.loads(result[key])
    return result


# --- Settings CRUD ---

async def get_settings() -> dict:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM settings WHERE id = 'default'")
        if row is None:
            return {"model_name": "claude-sonnet-4-20250514", "max_rounds": 3, "creativity": 0.2}
        return dict(row)


async def update_settings(fields: dict) -> dict:
    pool = await get_pool()
    allowed = {"model_name", "max_rounds", "creativity"}
    updates = {k: v for k, v in fields.items() if k in allowed}
    if not updates:
        raise ValueError("No valid fields to update")

    set_parts = []
    params = []
    idx = 1
    for key, val in updates.items():
        set_parts.append(f"{key} = ${idx}")
        params.append(val)
        idx += 1
    set_parts.append(f"updated_at = ${idx}")
    params.append(datetime.now(timezone.utc))

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            f"UPDATE settings SET {', '.join(set_parts)} WHERE id = 'default' RETURNING *",
            *params,
        )
        return dict(row)


async def get_judgements(
    turn_id: str | None = None,
    session_id: str | None = None,
) -> list[dict]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        if turn_id:
            rows = await conn.fetch(
                "SELECT * FROM judgements WHERE turn_id = $1 ORDER BY created_at",
                turn_id,
            )
        elif session_id:
            rows = await conn.fetch(
                """
                SELECT j.* FROM judgements j
                JOIN turns t ON t.id = j.turn_id
                WHERE t.session_id = $1
                ORDER BY j.created_at
                """,
                session_id,
            )
        else:
            rows = await conn.fetch(
                "SELECT * FROM judgements ORDER BY created_at",
            )
        results = []
        for row in rows:
            r = dict(row)
            if isinstance(r.get("scores"), str):
                r["scores"] = json.loads(r["scores"])
            results.append(r)
        return results


# --- Eval run CRUD (persisted Braintrust eval runs) ---

_EVAL_RUN_JSON_FIELDS = (
    "scorer_names",
    "scorer_averages",
    "per_row",
    "charter_snapshot",
    "improvement_suggestions",
)


def _parse_eval_run_row(row) -> dict:
    r = dict(row)
    for key in _EVAL_RUN_JSON_FIELDS:
        if isinstance(r.get(key), str):
            r[key] = json.loads(r[key])
    return r


async def create_eval_run(
    run_id: str,
    session_id: str,
    project: str,
    experiment_name: str | None,
    rows_total: int,
    skill_version_id: str | None,
    skill_version_number: int | None,
    charter_snapshot: dict | None = None,
) -> dict:
    """Insert a fresh pending eval run. The background task later updates it."""
    pool = await get_pool()
    charter_json = json.dumps(charter_snapshot, default=str) if charter_snapshot else None
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO eval_runs (
                id, session_id, status, project, experiment_name,
                rows_total, skill_version_id, skill_version_number, charter_snapshot
            )
            VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, $8::jsonb)
            RETURNING *
            """,
            run_id, session_id, project, experiment_name,
            rows_total, skill_version_id, skill_version_number, charter_json,
        )
        return _parse_eval_run_row(row)


async def update_eval_run(run_id: str, fields: dict) -> dict | None:
    """Update eval run columns. Unknown fields are silently dropped."""
    pool = await get_pool()
    allowed = {
        "status", "experiment_name", "experiment_url", "rows_evaluated",
        "scorer_names", "scorer_averages", "per_row", "error",
        "started_at", "finished_at",
        "improvement_suggestions", "improvement_summary",
    }
    updates = {k: v for k, v in fields.items() if k in allowed}
    if not updates:
        return await get_eval_run(run_id)

    # JSON columns can contain datetimes when per_row carries DB-row fields
    # (Example.created_at, etc.). default=str coerces them to ISO strings
    # so a single stray datetime doesn't blow up the whole run.
    for key in _EVAL_RUN_JSON_FIELDS:
        if key in updates and not isinstance(updates[key], str):
            updates[key] = json.dumps(updates[key], default=str)

    set_parts = []
    params: list = []
    idx = 1
    for key, val in updates.items():
        set_parts.append(f"{key} = ${idx}")
        params.append(val)
        idx += 1
    params.append(run_id)

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            f"UPDATE eval_runs SET {', '.join(set_parts)} WHERE id = ${idx} RETURNING *",
            *params,
        )
        return _parse_eval_run_row(row) if row else None


async def get_eval_run(run_id: str) -> dict | None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM eval_runs WHERE id = $1", run_id)
        return _parse_eval_run_row(row) if row else None


async def list_eval_runs(session_id: str, limit: int = 50) -> list[dict]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT * FROM eval_runs
            WHERE session_id = $1
            ORDER BY created_at DESC
            LIMIT $2
            """,
            session_id, limit,
        )
        return [_parse_eval_run_row(r) for r in rows]
