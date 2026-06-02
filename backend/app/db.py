"""Database connection and queries for sessions and seeds."""

from __future__ import annotations

import hashlib
import json
import secrets
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
        # charter -> seed rename migration (idempotent). Runs BEFORE the
        # `CREATE TABLE IF NOT EXISTS seeds` below so an existing `charters`
        # table is renamed in place rather than stranded next to a fresh empty
        # `seeds`. Guards via information_schema make every branch a no-op once
        # already applied (and on a brand-new database).
        #
        # Each rename is self-healing for the "both source and target already
        # exist" state — which arises if pre-rename code ran against an
        # already-migrated DB and re-created the old name (e.g. a stray
        # `ALTER TABLE ... ADD COLUMN IF NOT EXISTS charter_snapshot`). In that
        # case the target holds the real data and the source is an empty
        # re-add, so we backfill anything missing and drop the redundant source
        # instead of failing on a duplicate.
        await conn.execute("""
            DO $$ BEGIN
                -- Table: charters -> seeds
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'charters') THEN
                    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'seeds') THEN
                        ALTER TABLE charters RENAME TO seeds;
                    ELSIF (SELECT count(*) FROM charters) = 0 THEN
                        DROP TABLE charters;  -- stale empty re-create; `seeds` has the data
                    END IF;
                END IF;
                -- Column: seeds.charter -> seeds.seed
                IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'seeds' AND column_name = 'charter') THEN
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'seeds' AND column_name = 'seed') THEN
                        ALTER TABLE seeds RENAME COLUMN charter TO seed;
                    ELSE
                        UPDATE seeds SET seed = charter WHERE seed = '{}'::jsonb AND charter <> '{}'::jsonb;
                        ALTER TABLE seeds DROP COLUMN charter;
                    END IF;
                END IF;
                -- Column: datasets.charter_snapshot -> datasets.seed_snapshot
                IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'datasets' AND column_name = 'charter_snapshot') THEN
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'datasets' AND column_name = 'seed_snapshot') THEN
                        ALTER TABLE datasets RENAME COLUMN charter_snapshot TO seed_snapshot;
                    ELSE
                        UPDATE datasets SET seed_snapshot = charter_snapshot WHERE seed_snapshot IS NULL AND charter_snapshot IS NOT NULL;
                        ALTER TABLE datasets DROP COLUMN charter_snapshot;
                    END IF;
                END IF;
                -- Column: eval_runs.charter_snapshot -> eval_runs.seed_snapshot
                IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'eval_runs' AND column_name = 'charter_snapshot') THEN
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'eval_runs' AND column_name = 'seed_snapshot') THEN
                        ALTER TABLE eval_runs RENAME COLUMN charter_snapshot TO seed_snapshot;
                    ELSE
                        UPDATE eval_runs SET seed_snapshot = charter_snapshot WHERE seed_snapshot IS NULL AND charter_snapshot IS NOT NULL;
                        ALTER TABLE eval_runs DROP COLUMN charter_snapshot;
                    END IF;
                END IF;
            END $$;
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS seeds (
                id              TEXT PRIMARY KEY,
                session_id      TEXT NOT NULL REFERENCES sessions(id),
                created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
                finalised_at    TIMESTAMPTZ,
                seed         JSONB NOT NULL DEFAULT '{}'::jsonb,
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
                seed_snapshot  JSONB NOT NULL DEFAULT '{}'::jsonb,
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
        # Per-session/per-turn foreign-key indexes. Without these, deleting a
        # project sequential-scans the whole turns/judgements/datasets/seeds
        # tables per statement — cheap on a local dev DB, but slow in production
        # once turns (one row per LLM call) grows large. These back both the
        # cascading delete and any per-session lookups.
        await conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
        """)
        await conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_judgements_turn ON judgements(turn_id);
        """)
        await conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_datasets_session ON datasets(session_id);
        """)
        await conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_seeds_session ON seeds(session_id);
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
                model_name      TEXT NOT NULL DEFAULT 'claude-sonnet-4-5-20250929',
                max_rounds      INTEGER NOT NULL DEFAULT 3,
                creativity       REAL NOT NULL DEFAULT 0.2,
                updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
            );
        """)
        # Ensure default settings row exists
        await conn.execute("""
            INSERT INTO settings (id) VALUES ('default') ON CONFLICT (id) DO NOTHING;
        """)
        # One-time heal: retire dead model IDs that an earlier dropdown shipped.
        # The retired snapshots 404 at request time, which surfaces as
        # "Internal Server Error" on Improve / seed generation. Map them to
        # the closest live model in the same family.
        await conn.execute("""
            UPDATE settings SET model_name = 'claude-sonnet-4-5-20250929'
            WHERE model_name = 'claude-sonnet-4-20250514';
        """)
        await conn.execute("""
            UPDATE settings SET model_name = 'claude-haiku-4-5-20251001'
            WHERE model_name = 'claude-haiku-4-20250514';
        """)
        await conn.execute("""
            UPDATE settings SET model_name = 'claude-opus-4-7'
            WHERE model_name = 'claude-opus-4-20250514';
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
        # Migration: scenario_type folds is_adversarial into a richer categorical
        # (happy / edge / adversarial / degenerate) populated at synth time.
        # NULL on legacy rows; the review prompt and Dataset QA UI treat NULL as
        # "happy". We keep is_adversarial for legacy read-back but new writes
        # use scenario_type exclusively.
        await conn.execute("""
            ALTER TABLE examples ADD COLUMN IF NOT EXISTS scenario_type TEXT;
        """)
        await conn.execute("""
            ALTER TABLE examples ADD COLUMN IF NOT EXISTS difficulty TEXT;
        """)
        # tier marks how rows flow through the rest of the pipeline. "eval" is
        # the default — auto-review + eval runs treat these as the working set.
        # "golden" rows are hand-promoted and held to a higher bar; "discovery"
        # rows are scratch-pad scenarios that haven't been vetted yet.
        await conn.execute("""
            ALTER TABLE examples ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'eval';
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
        # Migration: capture the seed at run-creation time so the UI can
        # show exactly what was evaluated, even after later edits.
        await conn.execute("""
            ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS seed_snapshot JSONB;
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
        # Migration: capture the judge model used for each run so the history
        # UI can show "ran with claude-opus-4-7" etc. without having to dig
        # into per_row metadata. NULL on old rows; new rows always populate.
        await conn.execute("""
            ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS judge_model_used TEXT;
        """)
        # Migration: track when any per-row note was last edited. Compared
        # against clusters_generated_at (added later) to drive the
        # "notes changed since last analysis" hint. Denormalized so we don't
        # have to scan per_row JSONB on every page load to compute it.
        await conn.execute("""
            ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS notes_updated_at TIMESTAMPTZ;
        """)
        # Migration: cluster cache + freshness stamp. clusters is a list of
        # {label, count, row_ids} produced by clustering the per-row notes;
        # clusters_generated_at is set the same moment so the UI can detect
        # whether the notes have been edited since (notes_updated_at >
        # clusters_generated_at → stale).
        await conn.execute("""
            ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS clusters JSONB;
        """)
        await conn.execute("""
            ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS clusters_generated_at TIMESTAMPTZ;
        """)

        # Share tokens — every project ("session") can hand out viewer/editor
        # links. The plaintext token is generated once at create time and
        # surfaced to the caller exactly once; the row stores only the
        # sha256(token) hash, so a DB read alone can't be turned into working
        # share links. `token_preview` (first 8 chars + ellipsis) is captured
        # at create time so the owner UI can still distinguish two tokens at
        # a glance without ever re-exposing the secret.
        # ON DELETE CASCADE matches the rest of the per-session children.
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS share_tokens (
                id            UUID PRIMARY KEY,
                session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                token_hash    TEXT UNIQUE NOT NULL,
                token_preview TEXT NOT NULL,
                role          TEXT NOT NULL CHECK (role IN ('viewer','editor')),
                label         TEXT,
                created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
                revoked_at    TIMESTAMPTZ
            );
        """)
        await conn.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_share_tokens_hash
                ON share_tokens(token_hash);
        """)
        await conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_share_tokens_session
                ON share_tokens(session_id);
        """)

        # charter -> seed / skill_seed -> skill_import data migrations. Run after
        # every table exists; all are no-ops on a fresh database (0 rows). These
        # rename stored JSONB keys + provenance values that the column/table
        # renames above don't reach.
        # 1) live session state: { "charter": {...} } -> { "seed": {...} }
        await conn.execute("""
            UPDATE sessions
               SET state = (state - 'charter') || jsonb_build_object('seed', state -> 'charter')
             WHERE state ? 'charter';
        """)
        # 2) turn provenance: the skill-seed pass is now "skill_import"
        await conn.execute("""
            UPDATE turns SET turn_type = 'skill_import' WHERE turn_type = 'skill_seed';
        """)
        # 3) skill-version provenance value created_from "seed" -> "import"
        #    (nested array inside session state)
        await conn.execute("""
            UPDATE sessions
               SET state = jsonb_set(
                       state,
                       '{skill_versions}',
                       (SELECT jsonb_agg(
                            CASE WHEN elem ->> 'created_from' = 'seed'
                                 THEN jsonb_set(elem, '{created_from}', '"import"')
                                 ELSE elem END)
                        FROM jsonb_array_elements(state -> 'skill_versions') elem))
             WHERE jsonb_typeof(state -> 'skill_versions') = 'array'
               AND state -> 'skill_versions' @> '[{"created_from": "seed"}]';
        """)

        # Tables owned by self-contained app modules — they manage their own
        # schema, we just ensure it exists at startup. Import locally to keep
        # the dependency arrow one-way (db.py knows about these modules at
        # init time; the modules don't import db.py at import time).
        from . import llm_cache
        await llm_cache.create_table(conn)
        from . import quota
        await quota.create_table(conn)
        from . import spend_cap
        await spend_cap.create_table(conn)


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

        # Notify any open SSE subscribers that the session state changed.
        # Local import avoids a circular import: sharing imports db at module
        # load time. Best-effort — a publish failure must not undo the write.
        try:
            from .sharing import broadcaster
            await broadcaster.publish(session_id, {"type": "state_changed"})
        except Exception:  # noqa: BLE001
            pass

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
            # Compute has_seed from state
            seed = (state or {}).get("seed", {})
            has_seed = bool(
                seed.get("coverage", {}).get("criteria")
                or seed.get("alignment")
            )
            row["has_seed"] = has_seed
            row["kind"] = (state or {}).get("kind", "skill")
            row["prompt_target"] = (state or {}).get("prompt_target")
            results.append(row)
        return results


async def delete_session(session_id: str) -> None:
    """Delete a session and all associated data (cascading)."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        # One transaction so a mid-delete failure can't leave a session with
        # orphaned children. Delete in dependency order (children first).
        async with conn.transaction():
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
            await conn.execute("DELETE FROM seeds WHERE session_id = $1", session_id)
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
        # Notify SSE subscribers — a viewer watching the project should see
        # the rename live, not on next reload. Best-effort; never undo a write.
        try:
            from .sharing import broadcaster
            await broadcaster.publish(session_id, {"type": "state_changed"})
        except Exception:  # noqa: BLE001
            pass
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
        # Notify SSE subscribers so viewers see input edits without reloading.
        try:
            from .sharing import broadcaster
            await broadcaster.publish(session_id, {"type": "state_changed"})
        except Exception:  # noqa: BLE001
            pass
        return result


# --- Seed CRUD ---

async def create_seed(session_id: str, seed: dict, weak_criteria: list[dict] | None = None) -> dict:
    pool = await get_pool()
    seed_id = str(uuid.uuid4())
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO seeds (id, session_id, seed, weak_criteria)
            VALUES ($1, $2, $3, $4::jsonb)
            RETURNING id, session_id, created_at, finalised_at, seed, weak_criteria
            """,
            seed_id,
            session_id,
            json.dumps(seed),
            json.dumps(weak_criteria or []),
        )
        result = dict(row)
        if isinstance(result["seed"], str):
            result["seed"] = json.loads(result["seed"])
        if isinstance(result["weak_criteria"], str):
            result["weak_criteria"] = json.loads(result["weak_criteria"])
        return result


async def finalize_seed(seed_id: str) -> dict:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE seeds SET finalised_at = $2
            WHERE id = $1
            RETURNING id, session_id, created_at, finalised_at, seed, weak_criteria
            """,
            seed_id,
            datetime.now(timezone.utc),
        )
        if row is None:
            raise ValueError(f"Seed {seed_id} not found")
        result = dict(row)
        if isinstance(result["seed"], str):
            result["seed"] = json.loads(result["seed"])
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


async def sample_turns_for_prompt_eval(
    turn_type: str,
    limit: int = 50,
    exclude_session_id: str | None = None,
) -> list[dict]:
    """Sample completed turns for a prompt-eval seed.

    Filters: matching turn_type, has parsed_output (excludes mid-flight failures),
    and at least one llm_call recorded. Optionally excludes the prompt-eval
    project's own session so it doesn't sample turns it generated itself once
    re-runs start landing in turns.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        if exclude_session_id is not None:
            rows = await conn.fetch(
                """
                SELECT id, session_id, created_at, turn_type, input_snapshot,
                       parsed_output, agent_message
                FROM turns
                WHERE turn_type = $1
                  AND parsed_output IS NOT NULL
                  AND jsonb_array_length(llm_calls) > 0
                  AND session_id <> $3
                ORDER BY created_at DESC
                LIMIT $2
                """,
                turn_type, limit, exclude_session_id,
            )
        else:
            rows = await conn.fetch(
                """
                SELECT id, session_id, created_at, turn_type, input_snapshot,
                       parsed_output, agent_message
                FROM turns
                WHERE turn_type = $1
                  AND parsed_output IS NOT NULL
                  AND jsonb_array_length(llm_calls) > 0
                ORDER BY created_at DESC
                LIMIT $2
                """,
                turn_type, limit,
            )
        results = []
        for r in rows:
            d = dict(r)
            for key in ("input_snapshot", "parsed_output"):
                if isinstance(d.get(key), str):
                    d[key] = json.loads(d[key])
            results.append(d)
        return results


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

async def create_dataset(session_id: str, name: str, seed_snapshot: dict) -> dict:
    pool = await get_pool()
    dataset_id = str(uuid.uuid4())
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO datasets (id, session_id, name, seed_snapshot)
            VALUES ($1, $2, $3, $4)
            RETURNING *
            """,
            dataset_id, session_id, name, json.dumps(seed_snapshot),
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


async def create_dataset_version(dataset_id: str, seed_snapshot: dict) -> dict:
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
            INSERT INTO datasets (id, session_id, version, parent_version_id, name, status, seed_snapshot)
            VALUES ($1, $2, $3, $4, $5, 'draft', $6)
            RETURNING *
            """,
            new_id, current["session_id"], new_version, dataset_id,
            current["name"], json.dumps(seed_snapshot),
        )

        # Copy examples
        examples = await get_examples(dataset_id)
        for ex in examples:
            await conn.execute(
                """
                INSERT INTO examples (id, dataset_id, feature_area, input, expected_output,
                    coverage_tags, source, label, label_reason, review_status, reviewer_notes, judge_verdict,
                    should_trigger, is_adversarial, scenario_type, difficulty, tier)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
                """,
                str(uuid.uuid4()), new_id, ex["feature_area"], ex["input"], ex["expected_output"],
                json.dumps(ex.get("coverage_tags", [])), ex["source"], ex["label"],
                ex.get("label_reason"), ex["review_status"], ex.get("reviewer_notes"),
                json.dumps(ex.get("judge_verdict")) if ex.get("judge_verdict") else None,
                ex.get("should_trigger"), ex.get("is_adversarial"),
                ex.get("scenario_type"), ex.get("difficulty"), ex.get("tier", "eval"),
            )

        return _parse_dataset_row(row)


async def clear_new_tag_from_examples(example_ids: list[str]) -> int:
    """Atomically strip the "new" coverage tag from a specific set of example
    rows. Used after an eval run completes to mark its inputs as no longer
    fresh — scoped by id so a concurrent /refresh-from-turns can't have its
    just-inserted rows untagged out from under it.

    Returns the number of rows updated (rows that actually carried "new").
    """
    if not example_ids:
        return 0
    pool = await get_pool()
    async with pool.acquire() as conn:
        # `coverage_tags - 'new'` strips the value from the JSONB array (no-op
        # if absent). The @> filter avoids touching rows that never carried
        # the tag. Single statement → atomic vs concurrent inserts.
        result = await conn.execute(
            """
            UPDATE examples
            SET coverage_tags = coverage_tags - 'new'
            WHERE id = ANY($1::text[]) AND coverage_tags @> '["new"]'::jsonb
            """,
            example_ids,
        )
        # asyncpg returns "UPDATE n"; parse the count.
        try:
            return int(result.split()[-1])
        except (ValueError, IndexError):
            return 0


async def update_dataset_seed_snapshot(dataset_id: str, seed: dict) -> None:
    """Refresh the dataset's stored seed snapshot — used when the live
    seed has changed and gap analysis / scorers should compare against
    the new version (e.g. prompt-eval just generated its first seed)."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE datasets SET seed_snapshot = $1 WHERE id = $2",
            json.dumps(seed), dataset_id,
        )


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
    for key in ("stats", "seed_snapshot"):
        if key in result and isinstance(result[key], str):
            result[key] = json.loads(result[key])
    return result


# --- Example CRUD ---

async def _broadcast_dataset_change(dataset_id: str) -> None:
    """Resolve dataset_id → session_id and emit a state-changed event.

    Called from the example/dataset write helpers so a viewer subscribed via
    SSE sees row reviews, imports, and deletes live, not just on next reload.
    Best-effort — a publish failure must never undo the underlying write.
    """
    try:
        session_id = await get_session_id_for_dataset(dataset_id)
        if not session_id:
            return
        from .sharing import broadcaster
        await broadcaster.publish(session_id, {"type": "state_changed"})
    except Exception:  # noqa: BLE001
        pass


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
    scenario_type: str | None = None,
    difficulty: str | None = None,
    tier: str = "eval",
) -> dict:
    pool = await get_pool()
    example_id = str(uuid.uuid4())
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO examples (id, dataset_id, feature_area, input, expected_output,
                coverage_tags, source, label, label_reason, should_trigger, is_adversarial,
                scenario_type, difficulty, tier)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            RETURNING *
            """,
            example_id, dataset_id, feature_area, input_text, expected_output,
            json.dumps(coverage_tags or []), source, label, label_reason,
            should_trigger, is_adversarial,
            scenario_type, difficulty, tier,
        )
        result = _parse_example_row(row)
    await _broadcast_dataset_change(dataset_id)
    return result


async def bulk_create_examples(dataset_id: str, examples: list[dict]) -> list[dict]:
    pool = await get_pool()
    results = []
    async with pool.acquire() as conn:
        for ex in examples:
            row = await conn.fetchrow(
                """
                INSERT INTO examples (id, dataset_id, feature_area, input, expected_output,
                    coverage_tags, source, label, label_reason, review_status,
                    should_trigger, is_adversarial, scenario_type, difficulty, tier)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                RETURNING *
                """,
                str(uuid.uuid4()), dataset_id, ex["feature_area"], ex["input"],
                ex.get("expected_output", "") or "",
                json.dumps(ex.get("coverage_tags", [])), ex.get("source", "manual"),
                ex.get("label", "unlabeled"), ex.get("label_reason"),
                ex.get("review_status", "pending"),
                ex.get("should_trigger"),
                ex.get("is_adversarial"),
                ex.get("scenario_type"),
                ex.get("difficulty"),
                ex.get("tier", "eval"),
            )
            results.append(_parse_example_row(row))
    if results:
        await _broadcast_dataset_change(dataset_id)
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
               "revision_suggestion", "should_trigger", "is_adversarial",
               "scenario_type", "difficulty", "tier"}
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
        parsed = _parse_example_row(row)
    # Broadcast outside the connection so a slow subscriber can't hold the
    # pool. dataset_id is a TEXT FK on the row we just returned.
    dataset_id = parsed.get("dataset_id")
    if dataset_id:
        await _broadcast_dataset_change(str(dataset_id))
    return parsed


async def delete_example(example_id: str) -> bool:
    pool = await get_pool()
    async with pool.acquire() as conn:
        # Capture dataset_id before delete so we can broadcast afterwards.
        dataset_row = await conn.fetchrow(
            "SELECT dataset_id FROM examples WHERE id = $1", example_id,
        )
        result = await conn.execute("DELETE FROM examples WHERE id = $1", example_id)
    deleted = result == "DELETE 1"
    if deleted and dataset_row:
        await _broadcast_dataset_change(str(dataset_row["dataset_id"]))
    return deleted


async def delete_examples_for_dataset(dataset_id: str) -> int:
    """Bulk-delete every example row for a dataset. Used by the prompt-eval
    refresh path: we replace the rolling window of sampled rows in one go,
    so wiping the dataset's examples first keeps things atomic from the
    user's perspective. Returns the number of rows deleted (parsed from the
    asyncpg ``DELETE n`` status string)."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        status = await conn.execute(
            "DELETE FROM examples WHERE dataset_id = $1",
            dataset_id,
        )
        # status is "DELETE <n>" — parse the count for the API response.
        try:
            count = int(status.split()[-1])
        except (IndexError, ValueError):
            count = 0
    if count:
        await _broadcast_dataset_change(dataset_id)
    return count


async def count_curated_examples(dataset_id: str) -> int:
    """How many examples in this dataset carry user curation that a
    replace-mode refresh would silently destroy? Counts rows with a label
    that isn't ``unlabeled``, a non-default review_status, or any reviewer
    notes. Used by the refresh endpoint to surface ``rows_curation_lost``
    so the user knows what they're about to wipe."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT COUNT(*) AS n
            FROM examples
            WHERE dataset_id = $1
              AND (
                (label IS NOT NULL AND label NOT IN ('', 'unlabeled'))
                OR review_status NOT IN ('pending', 'approved')
                OR (reviewer_notes IS NOT NULL AND reviewer_notes <> '')
              )
            """,
            dataset_id,
        )
        return int(row["n"]) if row else 0


async def replace_examples_for_dataset(
    dataset_id: str,
    examples: list[dict],
) -> int:
    """Atomically swap the entire example set for a dataset.

    Wraps the DELETE + bulk-INSERT in a single transaction so a failure on
    the insert path leaves the existing rows in place rather than dropping
    the dataset to empty. Returns the number of rows deleted before the
    insert (parsed from the asyncpg ``DELETE n`` status string).

    Mirrors the per-row INSERT shape used by ``bulk_create_examples`` but
    can't reuse that helper directly because it acquires its own connection
    — sharing one connection here is what makes the operation atomic.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            status = await conn.execute(
                "DELETE FROM examples WHERE dataset_id = $1",
                dataset_id,
            )
            try:
                removed = int(status.split()[-1])
            except (IndexError, ValueError):
                removed = 0
            for ex in examples:
                await conn.execute(
                    """
                    INSERT INTO examples (id, dataset_id, feature_area, input, expected_output,
                        coverage_tags, source, label, label_reason, review_status,
                        should_trigger, is_adversarial, scenario_type, difficulty, tier)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                    """,
                    str(uuid.uuid4()), dataset_id, ex["feature_area"], ex["input"],
                    ex.get("expected_output", "") or "",
                    json.dumps(ex.get("coverage_tags", [])), ex.get("source", "manual"),
                    ex.get("label", "unlabeled"), ex.get("label_reason"),
                    ex.get("review_status", "pending"),
                    ex.get("should_trigger"),
                    ex.get("is_adversarial"),
                    ex.get("scenario_type"),
                    ex.get("difficulty"),
                    ex.get("tier", "eval"),
                )
            return removed


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
            return {"model_name": "claude-sonnet-4-5-20250929", "max_rounds": 3, "creativity": 0.2}
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


# --- Share token CRUD ---

async def create_share_token(
    session_id: str,
    role: str,
    label: str | None,
) -> dict:
    """Create a fresh share token for a session.

    Returns the row including the plaintext token under the `token` key —
    this is the **only** moment the plaintext is exposed. The DB only ever
    stores `sha256(token)`; subsequent reads via `list_share_tokens` show
    `token_preview` (first 8 chars + ellipsis). Caller is responsible for
    surfacing the plaintext to the user immediately and never persisting it
    elsewhere.
    """
    if role not in ("viewer", "editor"):
        raise ValueError(f"role must be 'viewer' or 'editor' (got {role!r})")
    token_id = str(uuid.uuid4())
    # 32 bytes of entropy → ~43 char base64url string. Comfortable margin
    # against guessing without bloating share URLs.
    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    token_preview = token[:8] + "…"
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO share_tokens (id, session_id, token_hash, token_preview, role, label)
            VALUES ($1::uuid, $2, $3, $4, $5, $6)
            RETURNING id, session_id, token_preview, role, label, created_at, revoked_at
            """,
            token_id, session_id, token_hash, token_preview, role, label,
        )
        result = dict(row)
        # Plaintext token only exists in memory here — return it once so the
        # caller can show it to the user. Never persisted in this dict's path.
        result["token"] = token
        return result


async def list_share_tokens(session_id: str) -> list[dict]:
    """Return active + revoked tokens for a session, plaintext redacted.

    `token_preview` is captured at create time (first 8 chars + ellipsis) so
    the owner can tell two tokens apart in the UI without the DB ever having
    to store the plaintext. Sorted newest-first to match the rest of the
    listing endpoints.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, session_id, token_preview, role, label, created_at, revoked_at
            FROM share_tokens
            WHERE session_id = $1
            ORDER BY created_at DESC
            """,
            session_id,
        )
    return [dict(r) for r in rows]


async def revoke_share_token(token_id: str, session_id: str) -> bool:
    """Mark a token revoked. Idempotent — already-revoked → returns False.

    Scoped by session_id so a token leaked from one project can't be revoked
    via someone else's owner endpoint (defense-in-depth; the endpoint also
    checks ownership before calling).
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        status = await conn.execute(
            """
            UPDATE share_tokens
            SET revoked_at = now()
            WHERE id = $1::uuid AND session_id = $2 AND revoked_at IS NULL
            """,
            token_id, session_id,
        )
        # asyncpg returns "UPDATE n"
        try:
            return int(status.split()[-1]) > 0
        except (IndexError, ValueError):
            return False


async def resolve_share_token(token: str) -> dict | None:
    """Look up an active token. Returns {session_id, role} or None.

    Hashes the incoming plaintext and looks up by `token_hash`, so the DB
    never sees the plaintext at rest. Returns None for both "doesn't exist"
    and "revoked" — the calling layer (`sharing.resolve_access`) maps both to
    a generic 403 to avoid leaking which leg of the lookup failed.
    """
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT session_id, role
            FROM share_tokens
            WHERE token_hash = $1 AND revoked_at IS NULL
            """,
            token_hash,
        )
        return dict(row) if row else None


async def get_session_id_for_dataset(dataset_id: str) -> str | None:
    """Cheap session_id lookup for dataset-scoped endpoints.

    The mutating dataset endpoints accept dataset_id in the path but auth on
    session_id. Loading the whole dataset row just to read one column was
    wasteful, so this helper exists for the auth dependency.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT session_id FROM datasets WHERE id = $1",
            dataset_id,
        )
        return row["session_id"] if row else None


# --- Eval run CRUD (persisted Braintrust eval runs) ---

_EVAL_RUN_JSON_FIELDS = (
    "scorer_names",
    "scorer_averages",
    "per_row",
    "seed_snapshot",
    "improvement_suggestions",
    "clusters",
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
    seed_snapshot: dict | None = None,
    judge_model_used: str | None = None,
) -> dict:
    """Insert a fresh pending eval run. The background task later updates it."""
    pool = await get_pool()
    seed_json = json.dumps(seed_snapshot, default=str) if seed_snapshot else None
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO eval_runs (
                id, session_id, status, project, experiment_name,
                rows_total, skill_version_id, skill_version_number, seed_snapshot,
                judge_model_used
            )
            VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, $8::jsonb, $9)
            RETURNING *
            """,
            run_id, session_id, project, experiment_name,
            rows_total, skill_version_id, skill_version_number, seed_json,
            judge_model_used,
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
        "clusters", "clusters_generated_at",
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


async def get_previous_clustered_run(
    session_id: str,
    project: str,
    excluding_run_id: str,
) -> dict | None:
    """Most recent prior run in the same (session, project) that has a
    cached clusters payload. Used by the analyze endpoint to seed
    cluster_notes with the previous run's labels — so the same failure
    mode keeps the same name across runs and the user can watch a bucket
    shrink ("23 → 8") instead of mentally remapping renamed labels.

    Scoped to project (not just session) because a session can host runs
    across multiple Braintrust projects, and a label that fits one
    project's failure mode rarely fits another's.

    Returns the run row or None when no prior clustered run exists yet
    (first analyze on this project's history)."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT * FROM eval_runs
            WHERE session_id = $1
              AND project = $2
              AND id != $3
              AND clusters IS NOT NULL
              AND clusters_generated_at IS NOT NULL
            ORDER BY clusters_generated_at DESC
            LIMIT 1
            """,
            session_id, project, excluding_run_id,
        )
        return _parse_eval_run_row(row) if row else None


async def set_eval_run_row_note(
    run_id: str,
    example_id: str,
    note: str,
) -> dict | None:
    """Set the note on a single per_row entry, addressing rows by their
    metadata.id (== examples.id, stable across resorts). Bumps
    notes_updated_at so the UI can tell when notes drift past the last
    cluster analysis.

    Returns the updated run row, or None if the run or example_id was not
    found.

    Concurrency: an empty note string clears the field but still bumps
    notes_updated_at — same intent as a non-empty edit. We rewrite the full
    per_row JSONB inside a single UPDATE; if two writes race, last-write-wins
    on the per_row column. Acceptable for v1 (single-tab editing is the norm).
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                "SELECT per_row FROM eval_runs WHERE id = $1 FOR UPDATE",
                run_id,
            )
            if row is None:
                return None
            per_row_raw = row["per_row"]
            per_row = json.loads(per_row_raw) if isinstance(per_row_raw, str) else per_row_raw
            if not isinstance(per_row, list):
                return None
            matched = False
            for entry in per_row:
                if not isinstance(entry, dict):
                    continue
                meta = entry.get("metadata") or {}
                if isinstance(meta, dict) and meta.get("id") == example_id:
                    if note:
                        entry["note"] = note
                    else:
                        entry.pop("note", None)
                    matched = True
                    break
            if not matched:
                return None
            updated = await conn.fetchrow(
                """
                UPDATE eval_runs
                SET per_row = $1::jsonb,
                    notes_updated_at = now()
                WHERE id = $2
                RETURNING *
                """,
                json.dumps(per_row, default=str),
                run_id,
            )
            return _parse_eval_run_row(updated) if updated else None
