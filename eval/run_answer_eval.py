"""Answer-quality eval runner (Doc 04 extension):

    python -m eval.run_answer_eval --goldenset eval/data/goldenset.jsonl --limit 10

For each in-material golden question: retrieve context -> generate a grounded answer ->
judge faithfulness + correctness. For a set of out-of-material questions: check the tutor
honestly abstains (labeled "general"). Prints a report and exits non-zero if any metric is
below threshold (so it can gate PRs). Makes OpenAI calls — run deliberately.
"""
from __future__ import annotations

import argparse
import json
import sys

import numpy as np

from .db import connect
from .embed import embed
from .answer_metrics import (
    generate_answer,
    judge_faithfulness,
    judge_correctness,
    is_general,
)

# Clearly out-of-material questions — the tutor should NOT confidently answer these as if
# they came from the course; it should go "general".
OUT_OF_MATERIAL = [
    "What's a good recipe for lasagna?",
    "Who won the 2018 FIFA World Cup?",
    "Summarize the plot of Hamlet.",
]

THRESHOLDS = {"faithfulness": 0.85, "correctness": 0.70, "abstention": 0.80}


def retrieve_context(question: str, course_id: str, k: int = 5) -> list[str]:
    q = np.asarray(embed([question])[0], dtype=np.float32)
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT mc.content
                   FROM material_chunks mc
                   JOIN materials m ON m.id = mc.material_id
                   WHERE m.deleted_at IS NULL AND mc.scope = 'shared' AND mc.course_id = %s
                   ORDER BY mc.embedding <=> %s
                   LIMIT %s""",
                (course_id, q, k),
            )
            return [r[0] for r in cur.fetchall()]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--goldenset", default="eval/data/goldenset.jsonl")
    ap.add_argument("-k", type=int, default=5)
    ap.add_argument("--limit", type=int, default=0, help="cap in-material questions (cost control)")
    args = ap.parse_args()

    golden = [json.loads(line) for line in open(args.goldenset) if line.strip()]
    if args.limit:
        golden = golden[: args.limit]
    if not golden:
        print("empty goldenset", file=sys.stderr)
        sys.exit(1)

    faith: list[bool] = []
    corr: list[bool] = []
    for item in golden:
        ctx = retrieve_context(item["question"], item["course_id"], args.k)
        answer = generate_answer(item["question"], ctx)
        faith.append(judge_faithfulness(ctx, answer))
        corr.append(judge_correctness(item["question"], item["reference_answer"], answer))

    course_id = golden[0]["course_id"]
    abst: list[bool] = []
    for q in OUT_OF_MATERIAL:
        ctx = retrieve_context(q, course_id, args.k)
        answer = generate_answer(q, ctx)
        abst.append(is_general(answer))

    def rate(xs: list[bool]) -> float:
        return round(sum(xs) / len(xs), 3) if xs else 0.0

    report = {
        "faithfulness": rate(faith),
        "correctness": rate(corr),
        "abstention": rate(abst),
        "n_in_material": len(faith),
        "n_out_of_material": len(abst),
    }
    print(json.dumps(report, indent=2))

    failed = [m for m, t in THRESHOLDS.items() if report.get(m, 0.0) < t]
    if failed:
        print(f"FAIL — below threshold: {failed}", file=sys.stderr)
        sys.exit(1)
    print("PASS")


if __name__ == "__main__":
    main()
