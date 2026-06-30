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
