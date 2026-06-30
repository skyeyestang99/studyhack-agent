"""Pure retrieval metrics for the RAG eval harness.

No external dependencies (stdlib only) so this is usable + testable immediately,
before the ingestion/retrieval pipeline exists. See Doc 04 (RAG Eval Harness).
"""
from __future__ import annotations

from dataclasses import dataclass
from math import log2
from typing import Iterable, Sequence


def recall_at_k(retrieved_ids: Sequence[str], relevant_ids: Sequence[str], k: int) -> float:
    rel = set(relevant_ids)
    if not rel:
        return 0.0
    top = set(retrieved_ids[:k])
    return len(rel & top) / len(rel)


def precision_at_k(retrieved_ids: Sequence[str], relevant_ids: Sequence[str], k: int) -> float:
    top = retrieved_ids[:k]
    if not top:
        return 0.0
    rel = set(relevant_ids)
    return sum(1 for r in top if r in rel) / len(top)


def hit_at_k(retrieved_ids: Sequence[str], relevant_ids: Sequence[str], k: int) -> float:
    return 1.0 if set(retrieved_ids[:k]) & set(relevant_ids) else 0.0


def reciprocal_rank(retrieved_ids: Sequence[str], relevant_ids: Sequence[str]) -> float:
    rel = set(relevant_ids)
    for i, rid in enumerate(retrieved_ids, start=1):
        if rid in rel:
            return 1.0 / i
    return 0.0


def ndcg_at_k(retrieved_ids: Sequence[str], relevant_ids: Sequence[str], k: int) -> float:
    rel = set(relevant_ids)
    dcg = sum(1.0 / log2(i + 1) for i, rid in enumerate(retrieved_ids[:k], start=1) if rid in rel)
    ideal = min(len(rel), k)
    idcg = sum(1.0 / log2(i + 1) for i in range(1, ideal + 1))
    return dcg / idcg if idcg > 0 else 0.0


def isolation_rate(retrieved_course_ids: Sequence[str], expected_course_id: str) -> float:
    """Fraction of retrieved chunks belonging to the correct course. 1.0 = perfect
    isolation (no cross-course leakage). Empty result counts as 1.0 (nothing leaked)."""
    if not retrieved_course_ids:
        return 1.0
    return sum(1 for c in retrieved_course_ids if c == expected_course_id) / len(retrieved_course_ids)


@dataclass
class QueryEval:
    recall: float
    precision: float
    hit: float
    rr: float
    ndcg: float
    isolation: float
    latency_ms: float


def _percentile(sorted_vals: list[float], p: float) -> float:
    if not sorted_vals:
        return 0.0
    pos = (len(sorted_vals) - 1) * (p / 100.0)
    lo = int(pos)
    hi = min(lo + 1, len(sorted_vals) - 1)
    if lo == hi:
        return sorted_vals[lo]
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (pos - lo)


def aggregate(evals: Iterable[QueryEval], k: int) -> dict:
    evals = list(evals)
    n = len(evals)
    if n == 0:
        return {}
    avg = lambda attr: sum(getattr(e, attr) for e in evals) / n
    lat = sorted(e.latency_ms for e in evals)
    return {
        "n": n,
        "k": k,
        "recall@k": round(avg("recall"), 4),
        "precision@k": round(avg("precision"), 4),
        "hit@k": round(avg("hit"), 4),
        "mrr": round(avg("rr"), 4),
        "ndcg@k": round(avg("ndcg"), 4),
        "isolation": round(avg("isolation"), 4),
        "p50_ms": round(_percentile(lat, 50), 2),
        "p95_ms": round(_percentile(lat, 95), 2),
    }
