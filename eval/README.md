# RAG Eval Harness

Measures **retrieval** quality first (deterministic, cheap, numeric — validates the
architecture), then layers generation eval. Full design: Doc 04 (RAG Eval Harness).

## Files
- `metrics.py` — pure retrieval metrics (Recall@k, Precision@k, Hit@k, MRR, nDCG@k,
  isolation rate, latency p50/p95). **No deps — usable now.**
- `test_metrics.py` — runnable tests: `python3 eval/test_metrics.py`.
- `retriever.py` — `Retriever` interface (the seam for the real agent retriever) + `DummyRetriever`.
- `run_retrieval_eval.py` — golden set → retriever → metrics report + threshold gate (CI).
- `generate_goldenset.py` — build a golden set from the seed corpus (LLM Q→A per chunk). *(scaffold)*

## Run
```bash
python3 eval/test_metrics.py                 # works today (pure metrics)
# once the ingest slice + seed corpus exist and build_retriever() is wired:
python -m eval.generate_goldenset --out eval/data/goldenset.jsonl --per-chunk 2
python -m eval.run_retrieval_eval --goldenset eval/data/goldenset.jsonl -k 5
```

## Build order (Doc 04)
seed corpus (#24) → minimal ingest slice (extract→chunk→embed) → **golden-set + retrieval eval (baseline numbers)** → CI gate → generation eval (RAGAS) → scaling sweep.

## Notes
- Run against a **Neon branch**, not prod data (isolated, reproducible).
- Isolation (no cross-course leakage) and no-context (don't hallucinate) are first-class assertions.


## Answer-quality eval (Doc 04 extension)

Retrieval eval measures whether we *find* the right chunks. Answer eval measures whether the
*answer* is trustworthy — the RAG faithfulness/correctness/abstention metrics:

```bash
python -m eval.run_answer_eval --goldenset eval/data/goldenset.jsonl --limit 10
```

- **faithfulness** — every factual claim supported by the retrieved context (LLM judge)
- **correctness** — answer matches the golden `reference_answer` (LLM judge)
- **abstention** — out-of-material questions get an honest "general" answer, not a confident bluff

Exits non-zero if any metric is below `THRESHOLDS` (CI gate). Makes OpenAI calls per question
(generate + 2 judges), so run it deliberately / on a capped `--limit`. Seed + ingest materials
first (see repo root) so there's a corpus to answer from.

## Auto-build golden sets from feedback

Turn 👍'd answers into per-course golden entries, then score them:
```bash
python -m eval.build_goldenset_from_feedback --course <uuid> --out eval/data/goldenset_feedback.jsonl
python -m eval.run_answer_eval --goldenset eval/data/goldenset_feedback.jsonl
```
This closes the loop: real usage → feedback → eval set → measured answer quality.
