"""End-to-end test for the kNN-against-labels scorer wiring.

What this proves:

1. ``make_knn_voter`` returns a callable that votes correctly against a
   handcrafted labeled pool — good neighbors push the score up, bad
   neighbors push it down, an even split lands at 0.5.
2. ``compile_scorers`` injects ``knn_vote`` into a generated scorer's
   namespace so a hand-written kNN scorer compiles and runs through the
   adapter end-to-end.
3. The adapter captures the kNN trace (neighbors + score) into
   ``scorer_metadata`` so the eval-result UI and the training corpus can
   surface it. Without the trace there's no answer to "why did this row
   get 60%?" — exactly the problem we already solved for the judge path.

The provider is faked via ``embeddings._set_provider_for_tests`` so this
test never touches Voyage. We do NOT spin up a real Braintrust Eval —
that's a smoke test, not a unit test; the runtime adapter is what we're
verifying here.
"""

from __future__ import annotations

import pytest

from app import embeddings as emb
from app.eval_runner import compile_scorers, make_knn_voter


class _DimEchoProvider(emb._EmbeddingProvider):
    """Returns a deterministic 4-d vector derived from the first char of
    each input. Lets us build labeled pools where good/bad rows are
    *geometrically* close to specific test inputs without depending on a
    real embedding distribution."""

    dimensions = 4

    def embed(self, texts, *, model):  # noqa: ANN001
        out = []
        for t in texts:
            # First char drives the vector: 'a'-start → [1,0,0,0],
            # 'b'-start → [0,1,0,0], etc. Texts that don't fit fall back
            # to a neutral vector that's not cosine-similar to any of the
            # bucketed ones.
            t = (t or "").strip().lower()
            v = [0.1, 0.1, 0.1, 0.1]
            if t.startswith("a"):
                v = [1.0, 0.0, 0.0, 0.0]
            elif t.startswith("b"):
                v = [0.0, 1.0, 0.0, 0.0]
            elif t.startswith("c"):
                v = [0.0, 0.0, 1.0, 0.0]
            elif t.startswith("d"):
                v = [0.0, 0.0, 0.0, 1.0]
            out.append(v)
        return out


@pytest.fixture(autouse=True)
def _fake_provider() -> None:
    emb._set_provider_for_tests(_DimEchoProvider())
    yield
    emb._set_provider_for_tests(None)


def _make_pool() -> list[dict]:
    """A small labeled pool covering both classes across two clusters.

    Cluster ``a*`` is mostly good, cluster ``b*`` is mostly bad.
    Cluster ``c*`` is evenly split — for the "abstain" assertion."""
    return [
        {"id": "p1", "input": "apple", "embedding": [1.0, 0.0, 0.0, 0.0], "label": "good"},
        {"id": "p2", "input": "ant", "embedding": [1.0, 0.0, 0.0, 0.0], "label": "good"},
        {"id": "p3", "input": "axe", "embedding": [1.0, 0.0, 0.0, 0.0], "label": "good"},
        {"id": "p4", "input": "bad", "embedding": [0.0, 1.0, 0.0, 0.0], "label": "bad"},
        {"id": "p5", "input": "bug", "embedding": [0.0, 1.0, 0.0, 0.0], "label": "bad"},
        {"id": "p6", "input": "cat", "embedding": [0.0, 0.0, 1.0, 0.0], "label": "good"},
        {"id": "p7", "input": "cup", "embedding": [0.0, 0.0, 1.0, 0.0], "label": "bad"},
    ]


def test_knn_vote_good_neighborhood_scores_high() -> None:
    """An ``a*`` candidate lands among 3 good neighbors → score near 1."""
    vote = make_knn_voter(_make_pool())
    score = vote("apple-pie", k=3)
    assert score is not None
    assert score > 0.9  # all 3 nearest are good


def test_knn_vote_bad_neighborhood_scores_low() -> None:
    """A ``b*`` candidate lands among only bad neighbors → score near 0."""
    vote = make_knn_voter(_make_pool())
    score = vote("brick", k=3)
    assert score is not None
    # k=3 with 2 bad neighbors at sim=1.0 and one weaker at sim=0.1 still
    # weights bad dominantly; score must be below 0.3 to pass.
    assert score < 0.3


def test_knn_vote_split_neighborhood_abstains_near_half() -> None:
    """A ``c*`` candidate's 2 nearest neighbors are good + bad with equal
    similarity → weighted vote cancels → score should be near 0.5."""
    vote = make_knn_voter(_make_pool())
    score = vote("cargo", k=2)
    assert score is not None
    assert 0.4 < score < 0.6


def test_knn_vote_empty_pool_returns_none() -> None:
    """No labeled embeddings yet → voter abstains for every row. The
    adapter reads ``None`` as a row-skip, matching the coverage-gate
    contract."""
    vote = make_knn_voter([])
    assert vote("anything", k=5) is None


def test_knn_vote_empty_output_returns_zero() -> None:
    """An empty candidate output deserves 0, not None — the model under
    test actually produced nothing, which is a fail. None would skip the
    row entirely and hide the failure."""
    vote = make_knn_voter(_make_pool())
    assert vote("", k=5) == 0.0
    assert vote("   ", k=5) == 0.0


def test_knn_vote_captures_neighbors_in_last_response() -> None:
    """The voter's ``.last_response`` should carry a JSON-serialisable
    summary of the neighbors. The adapter persists this into per-row
    metadata; without it the UI couldn't show which labeled rows drove
    the vote."""
    import json

    vote = make_knn_voter(_make_pool())
    vote("apple-pie", k=3)
    trace = json.loads(vote.last_response)
    assert trace["k"] == 3
    assert trace["pool_size"] == 7
    assert len(trace["neighbors"]) == 3
    assert all("similarity" in n for n in trace["neighbors"])
    assert all(n["label"] in ("good", "bad") for n in trace["neighbors"])


# --- compile_scorers integration ---------------------------------------------


KNN_SCORER_CODE = '''
def knn_eval(output, input, metadata):
    """Use the injected knn_vote helper to score this row."""
    return knn_vote(output, k=3)
'''


def _adapter_for_knn(pool: list[dict]):
    """Build a compiled adapter for a kNN scorer using the given pool.

    Mirrors what ``run_eval_sync`` does — make a voter, hand it to
    ``compile_scorers``, return the one adapter. ``scorer_traces`` is
    inspected in tests to confirm the kNN response landed there."""
    voter = make_knn_voter(pool)
    traces: dict[tuple[str, str], dict] = {}
    scorers = compile_scorers(
        [{"name": "knn_eval", "code": KNN_SCORER_CODE, "description": "kNN test scorer"}],
        call_judge=lambda prompt: 0.0,  # unused
        scorer_traces=traces,
        knn_vote=voter,
    )
    assert len(scorers) == 1
    return scorers[0], traces


def test_compile_scorers_injects_knn_vote_into_namespace() -> None:
    """The compiled adapter should be callable with (output, input, metadata)
    and use the injected ``knn_vote`` to produce a score."""
    adapter, traces = _adapter_for_knn(_make_pool())
    result = adapter("apple-pie", input="some-prompt", metadata={"id": "row-1"})
    assert result["name"] == "knn_eval"
    assert result["score"] is not None
    assert result["score"] > 0.9


def test_compile_scorers_records_knn_trace_in_metadata() -> None:
    """The kNN response + score should land in scorer_metadata so the UI
    and the training corpus can read them. Mirrors how ``judge_response``
    is captured for judge scorers."""
    adapter, traces = _adapter_for_knn(_make_pool())
    adapter("brick", input="prompt", metadata={"id": "row-2"})
    assert ("row-2", "knn_eval") in traces
    trace = traces[("row-2", "knn_eval")]
    assert "knn_response" in trace
    assert "knn_score" in trace
    assert trace["knn_score"] < 0.3  # bad-neighborhood candidate


def test_compile_scorers_no_pool_fallback_skips_row() -> None:
    """When the pool is empty, the voter returns None — the adapter
    should treat that as a row-skip (score=None, metadata.skipped=True),
    not as a 0% score. This is the same contract coverage scorers use
    when the row doesn't match their tag."""
    adapter, traces = _adapter_for_knn([])
    result = adapter("anything", input="prompt", metadata={"id": "row-3"})
    assert result["score"] is None
    assert result["metadata"].get("skipped") is True
