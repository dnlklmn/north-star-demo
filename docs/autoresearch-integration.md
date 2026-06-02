# Auto-improve: Applying the Autoresearch Loop to Dataset Quality

Adapts Karpathy's autoresearch pattern — automated experiment loops with a fixed evaluator — to iteratively improve dataset quality in North Star. Instead of optimizing training code against validation loss, we optimize examples against the charter.

---

## The mapping

| Autoresearch concept | North Star equivalent |
|---|---|
| Direction file (human-authored, immutable during run) | Charter (Coverage, Balance, Alignment, Rot) |
| Evaluator (validation metric) | Judge (scores examples against charter alignment definitions) |
| Implementation (agent-modifiable) | The dataset examples themselves |
| 5-minute experiment budget | Per-example or per-batch improvement cycle |
| Keep/discard decision | Judge confidence threshold — keep improvement or revert |

The core idea: run the judge not just as a one-shot review tool, but as the scoring function in a tight loop where an agent iteratively rewrites examples until they're strong.

---

## What gets auto-improved

### 1. Example quality (primary use case)

The agent rewrites individual examples to better match charter alignment definitions. Each cycle:

1. Pick an example (prioritize: low judge confidence, unlabeled, or flagged)
2. Read the charter context for that example's feature area
3. Generate an improved version of the expected_output (and optionally the input)
4. Run the judge on both original and improved version
5. Keep the version with higher confidence; discard the other
6. Log the delta

This is the tightest loop and the most direct analog to autoresearch. The charter's alignment definitions (good/bad per feature area) serve as the "what we're optimizing toward" and the judge is the automated scorer.

### 2. Coverage gap filling

Rather than improving existing examples, generate new ones for uncovered areas:

1. Run gap analysis — find coverage criteria with 0 or few approved examples
2. For each gap, generate a candidate example
3. Judge scores it
4. If confidence is below threshold, regenerate with feedback from the judge's reasoning
5. Repeat up to N attempts per gap
6. Surface the best candidate for human review

This is less "autoresearch" and more "auto-enrichment with quality gating," but the loop structure is the same.

### 3. Adversarial hardening

Generate deliberately tricky inputs that stress-test the alignment definitions:

1. For each feature area, ask the agent to generate an input that's ambiguous — could be good or bad depending on interpretation
2. Generate an expected_output
3. Run the judge — if confidence is high, the example is clear and useful
4. If confidence is low, the example has exposed a weak alignment definition
5. Surface low-confidence adversarial examples to the user as "your charter may need clarification here"

This inverts the loop: instead of improving examples to match the charter, it uses example generation to stress-test the charter.

---

## Architecture

### New components

```
backend/app/
  autoimprove.py        # The experiment loop orchestrator
  prompt.py             # New prompts: improve_example, generate_adversarial
  tools.py              # New tool: run_improvement_cycle
```

### The loop (autoimprove.py)

```python
async def run_improvement_loop(
    dataset_id: str,
    mode: "quality" | "coverage" | "adversarial",
    max_cycles: int = 50,        # total improvement attempts
    cycle_budget_sec: int = 30,  # wall-clock per cycle (like autoresearch's 5 min)
    confidence_threshold: float = 0.8,
    stop_on_plateau: bool = True,
):
    """
    The autoresearch-style loop.
    
    Immutable during run:
      - Charter (the direction file)
      - Judge prompt (the evaluator)
    
    Mutable:
      - Examples (the implementation)
    """
    
    charter = get_charter_snapshot(dataset_id)
    examples = get_improvable_examples(dataset_id, mode)
    
    results = []
    consecutive_no_improvement = 0
    
    for cycle in range(max_cycles):
        example = pick_next(examples, mode)
        
        # Generate improved version
        improved = await improve_example(example, charter, mode)
        
        # Score both with the judge
        original_score = await judge(example, charter)
        improved_score = await judge(improved, charter)
        
        # Keep or discard
        if improved_score.confidence > original_score.confidence:
            apply_improvement(example, improved)
            results.append({"kept": True, "delta": improved_score.confidence - original_score.confidence})
            consecutive_no_improvement = 0
        else:
            results.append({"kept": False})
            consecutive_no_improvement += 1
        
        # Plateau detection
        if stop_on_plateau and consecutive_no_improvement >= 5:
            break
    
    return ImprovementReport(results)
```

### Three-file contract (enforced, not just conventional)

This is the key design constraint borrowed from autoresearch:

1. **Charter (frozen):** Snapshot the charter at the start of the run. Even if the user edits the charter mid-run, the loop uses the snapshot. This prevents the evaluator from shifting under the optimizer.

2. **Judge prompt (frozen):** The judge prompt is locked for the duration of the run. Same reason — if the scoring function changes mid-experiment, results aren't comparable.

3. **Examples (mutable):** The only thing the loop is allowed to change. Every mutation is logged with before/after + judge scores.

---

## API

| Method | Path | Description |
|---|---|---|
| POST | /datasets/{id}/autoimprove | Start an improvement run |
| GET | /datasets/{id}/autoimprove/{run_id} | Get run status + results |
| POST | /datasets/{id}/autoimprove/{run_id}/stop | Stop a running loop |
| GET | /datasets/{id}/autoimprove/history | List past runs |

### POST /datasets/{id}/autoimprove

```json
{
  "mode": "quality",
  "max_cycles": 50,
  "confidence_threshold": 0.8,
  "target_feature_areas": ["order tracking", "returns"],
  "stop_on_plateau": true
}
```

### Response (run complete)

```json
{
  "run_id": "...",
  "status": "completed",
  "cycles_run": 34,
  "improvements_kept": 12,
  "improvements_discarded": 22,
  "avg_confidence_before": 0.62,
  "avg_confidence_after": 0.79,
  "plateau_reached": true,
  "charter_snapshot_id": "...",
  "examples_modified": ["ex_1", "ex_5", "ex_12", ...]
}
```

---

## UI

### Trigger

A button in the dataset phase top bar: "Auto-improve" (next to Import, Generate, Auto-review, Export).

Clicking opens a config panel:

- **Mode:** Quality / Coverage / Adversarial
- **Scope:** All examples, or filter by feature area
- **Budget:** Max cycles (default 50)
- **Threshold:** Minimum confidence to accept (default 0.8)

### During the run

The agent column shows a live feed, similar to autoresearch's terminal output:

```
Cycle 1/50: order tracking — "Customer asks about delayed order"
  Original confidence: 0.58
  Improved confidence: 0.81 ✓ kept
  
Cycle 2/50: returns — "User wants to return opened item"  
  Original confidence: 0.72
  Improved confidence: 0.69 ✗ discarded

Cycle 3/50: ...
```

### After the run

Show an improvement report:

- Before/after confidence distribution (histogram or box plot)
- List of kept improvements with diffs (original → improved expected_output)
- Any plateau or stop conditions hit
- Suggested next action: "Review the 12 improved examples" or "Your charter's alignment definition for 'returns' may be too vague — the judge couldn't consistently score examples"

All improvements land as `review_status: "pending"` — the human still has final say, just like the existing review flow. The auto-improve loop is a power tool for getting better draft examples, not a way to bypass review.

---

## What makes this different from just "run the judge"

The existing auto-review flow is one-shot: judge scores examples, human reviews. Auto-improve closes the loop:

- **Auto-review:** charter → judge → scores → human decides
- **Auto-improve:** charter → judge → scores → agent rewrites → judge re-scores → keep/discard → repeat

The agent is doing the "try again" step that currently only a human does. The judge is doing the "is this better?" step that currently only a human does. The human's job shifts from "fix each example" to "review the improvements and refine the charter when the loop stalls."

---

## Risks and constraints

**Goodhart's law.** The agent will optimize for the judge's scoring function, not for actual quality. If the judge prompt has blind spots, the agent will exploit them. Mitigation: surface low-confidence examples and charter-ambiguity signals to the user. The adversarial mode specifically probes for this.

**Cost.** Each cycle is 2 LLM calls (improve + judge). 50 cycles = 100 calls. At ~$0.003/call with Sonnet, a full run is ~$0.30. Acceptable, but should show estimated cost before starting.

**Convergence.** The loop may not converge if the charter's alignment definitions are vague. This is actually a feature — it surfaces charter quality issues. If auto-improve plateaus at low confidence, the signal is "improve your charter," not "run more cycles."

**Review burden.** 50 cycles producing 15 improvements still means 15 examples to review. The UI should make this easy — show the diff, show the judge's reasoning, one-click approve.
