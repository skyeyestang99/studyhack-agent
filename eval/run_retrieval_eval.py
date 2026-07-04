"""Retrieval eval runner: golden set -> retriever -> metrics report + CI gate.

    python -m eval.run_retrieval_eval --goldenset eval/data/goldenset.jsonl -k 5

Wire the real retriever in `build_retriever()`. Exits non-zero if any threshold
fails (so it can act as a PR regression gate). See Doc 04.
"""
from __future__ import annotations

import argparse
import json
import sys
import time

from .metrics import (
    QueryEval, aggregate, recall_at_k, precision_at_k,
    hit_at_k, reciprocal_rank, ndcg_at_k, isolation_rate,
)
from .retriever import Retriever

# Initial gate thresholds (tune after the first baseline run).
THRESHOLDS = {"recall@k": 0.85, "mrr": 0.70, "isolation": 1.0}


def build_retriever() -> Retriever:
    # TODO: return the real agent retriever (pgvector course-scoped search over
    # material_chunks). Until then, tests inject a DummyRetriever.
    raise NotImplementedError(
        "Wire the agent retriever here, or pass a retriever into evaluate() in tests."
    )


def load_goldenset(path: str) -> list[dict]:
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def evaluate(retriever: Retriever, goldenset: list[dict], k: int = 5) -> dict:
    evals: list[QueryEval] = []
    for item in goldenset:
        start = time.perf_counter()
        results = retriever.retrieve(item["question"], item["course_id"], k)
        latency_ms = (time.perf_counter() - start) * 1000.0
        retrieved_ids = [r.chunk_id for r in results]
        course_ids = [r.course_id for r in results]
        relevant = [item["source_chunk_id"]]
        evals.append(QueryEval(
            recall=recall_at_k(retrieved_ids, relevant, k),
            precision=precision_at_k(retrieved_ids, relevant, k),
            hit=hit_at_k(retrieved_ids, relevant, k),
            rr=reciprocal_rank(retrieved_ids, relevant),
            ndcg=ndcg_at_k(retrieved_ids, relevant, k),
            isolation=isolation_rate(course_ids, item["course_id"]),
            latency_ms=latency_ms,
        ))
    return aggregate(evals, k)


def gate(report: dict) -> list[str]:
    return [m for m, t in THRESHOLDS.items() if report.get(m, 0.0) < t]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--goldenset", default="eval/data/goldenset.jsonl")
    ap.add_argument("-k", type=int, default=5)
    args = ap.parse_args(argv)

    goldenset = load_goldenset(args.goldenset)
    report = evaluate(build_retriever(), goldenset, args.k)
    print(json.dumps(report, indent=2))

    failed = gate(report)
    if failed:
        print(f"FAIL — below threshold: {failed}")
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
