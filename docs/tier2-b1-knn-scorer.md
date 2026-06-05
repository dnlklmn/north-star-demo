# Tier 2 B1 — kNN-against-labels scorer

> **Purpose.** Add the first scoring method that gets *better* every
> time a user labels a row. Pre-prod, this is the smallest piece of
> Tier 2 that delivers a user-visible result, and the embedding column
> it introduces is reused by B2 (cascade routing) and B3
> (Coverage / Balance / Rot signals) without further migration.

## What this PR ships

| Surface | Change |
|---|---|
| `backend/app/embeddings.py` (new) | Provider abstraction + Voyage AI `voyage-3-lite` implementation + in-process cache + `cosine_similarity` |
| `backend/app/db.py` | `examples.embedding` (JSONB) + `examples.embedding_model` (TEXT) + partial index. New helpers: `set_example_embedding`, `get_labeled_embeddings`, `count_dataset_embedding_status` |
| `backend/app/main.py` | `POST /datasets/{id}/embed-examples` (backfill), `GET /datasets/{id}/embedding-status`. `_execute_eval_run` preloads the labeled pool |
| `backend/app/eval_runner.py` | `make_knn_voter(pool)` (mirrors `make_judge` shape); `compile_scorers` accepts `knn_vote` and injects it into each scorer's namespace; adapter captures `knn_response` + `knn_score` into `scorer_metadata` |
| `backend/app/scorer_publish.py` | `_is_deterministic_scorer` excludes `knn_vote(`; new `_is_knn_scorer`; emits `scoring_method: knn` in published frontmatter |
| `frontend/src/utils/scorerKind.ts` | New `ScorerKind = 'deterministic' \| 'judge' \| 'knn'`. `classifyScorer`, `isKnnScorer`, `isJudgeScorer` helpers. `countScorerKinds` returns `{deterministic, judge, knn, total}` |
| `frontend/src/components/ScorersPanel.tsx` | Three-section grouping: Deterministic → kNN → Judge |
| `frontend/src/components/EvaluatePanel.tsx` | Judge-model hint mentions kNN scorers also run without LLM calls |
| `.env.example` | `VOYAGE_API_KEY`, `EMBEDDING_MODEL` |
| Tests | `backend/tests/test_embeddings.py` (12 tests) + `backend/tests/test_knn_scorer.py` (9 tests) |

## Decisions

### Embedder: Voyage AI `voyage-3-lite`

- **512 dimensions** — small JSONB rows, fast Python-side cosine.
- **$0.02 / 1M tokens** — same order as OpenAI `text-embedding-3-small`.
  A 500-row dataset costs single-digit cents to embed.
- **Anthropic-aligned partner** — fits the existing provider story.
- **No SDK** — single `httpx` POST. Trivial to swap to OpenAI or others
  by subclassing `_EmbeddingProvider` and changing `_default_provider()`.

`embedding_model` is co-stored with the vector. The kNN reader filters
on it, refusing to match across providers — a mismatch is a routing bug
we want to detect, not silently retrieve through.

### Storage: in-memory cosine over JSONB

Pre-prod scale is hundreds-to-thousands of examples per dataset. Cosine
in Python over that pool is microseconds. pgvector adds dependency
complexity that isn't paying for itself yet — when a dataset crosses
~50K embeddings we'll add a `vector` column + index and swap the reader.
The JSONB column survives that migration as the canonical store; the
vector column would be an index, not a source of truth.

### Pool freshness during a run

The labeled pool is snapshotted **once per run** in `_execute_eval_run`
and closed over by the voter. Labels landing mid-run intentionally do
NOT shift earlier rows' scores — that would make a run irreproducible.
The next eval run picks the updated pool up.

## How a kNN scorer looks (generator change is OUT OF SCOPE)

This PR ships the runtime + the publish path. The generator (`prompt.py`)
still emits judge-and-deterministic scorers. A user (or a follow-up PR)
can hand-author a kNN scorer in this shape:

```python
def my_knn_scorer(output, input, metadata):
    """Vote based on the 5 nearest labeled rows."""
    return knn_vote(output, k=5)
```

The runtime injects `knn_vote` into the scorer's namespace. The voter
returns:
- A float in `[0, 1]` — weighted vote, 0.5 means neighbors split evenly
- `None` when the pool is empty (treated as a row-skip by the adapter)
- `0.0` when `output` is empty (the scorer DID produce nothing — that's a fail)

## What's next

| | Why | When |
|---|---|---|
| B1 follow-up: generator emits kNN scorers | Make this the *first-class* scoring method for Coverage criteria — currently you have to hand-author | When a user has ≥50 labeled rows; otherwise judge stays the default |
| B3 — Coverage / Balance / Rot as embedding-distribution signals | Reuses the embedding column. Three currently-empty charter dimensions get measurable metrics | After this lands |
| B2 — Cascade routing | Embed each output → confident clusters auto-score → ambiguous middle goes to judge. Cost optimisation | Post-production traffic — current cost isn't pressing |

## Out of scope

- ❌ Generator changes — see follow-up.
- ❌ pgvector — see "Storage" above.
- ❌ Auto-embed on example create — backfill endpoint covers all cases
  for now; auto-embed would touch every synthesis + import + manual-add
  call site and inflate the surface for very little benefit pre-prod.
- ❌ UI for triggering backfill — exposed as an API only; the next PR
  adds the button on the Dataset / Scorers panel.
