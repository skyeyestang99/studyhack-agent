"""Runnable tests for metrics.py (stdlib only): `python3 test_metrics.py`."""
from metrics import (
    recall_at_k, precision_at_k, hit_at_k, reciprocal_rank,
    ndcg_at_k, isolation_rate, aggregate, QueryEval,
)


def approx(a, b, tol=1e-6):
    return abs(a - b) <= tol


def main() -> int:
    # recall
    assert recall_at_k(["a", "b", "c"], ["b"], 5) == 1.0
    assert recall_at_k(["a", "b"], ["x"], 5) == 0.0
    assert recall_at_k(["a", "b"], ["x"], 5) == 0.0
    # precision
    assert approx(precision_at_k(["a", "b", "c", "d", "e"], ["a"], 5), 0.2)
    assert precision_at_k([], ["a"], 5) == 0.0
    # hit
    assert hit_at_k(["a", "b"], ["b"], 5) == 1.0
    assert hit_at_k(["a"], ["b"], 5) == 0.0
    # MRR
    assert approx(reciprocal_rank(["a", "b", "c"], ["c"]), 1 / 3)
    assert reciprocal_rank(["a", "b"], ["x"]) == 0.0
    # nDCG: relevant at rank 1 -> 1.0; at rank 2 -> < 1.0
    assert ndcg_at_k(["rel"], ["rel"], 5) == 1.0
    assert ndcg_at_k(["x", "rel"], ["rel"], 5) < 1.0
    # isolation
    assert approx(isolation_rate(["c1", "c1", "c2"], "c1"), 2 / 3)
    assert isolation_rate([], "c1") == 1.0
    assert isolation_rate(["c1", "c1"], "c1") == 1.0
    # aggregate
    evals = [
        QueryEval(recall=1.0, precision=0.2, hit=1.0, rr=1.0, ndcg=1.0, isolation=1.0, latency_ms=10.0),
        QueryEval(recall=0.0, precision=0.0, hit=0.0, rr=0.0, ndcg=0.0, isolation=1.0, latency_ms=30.0),
    ]
    agg = aggregate(evals, k=5)
    assert agg["n"] == 2
    assert approx(agg["recall@k"], 0.5)
    assert approx(agg["mrr"], 0.5)
    assert agg["isolation"] == 1.0
    assert agg["p50_ms"] == 20.0
    print("ALL METRICS TESTS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
