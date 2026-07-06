"""Auto-build a per-course golden set from 👍'd answers (feedback loop → eval).

Every answer a student rated 👍 becomes a golden {question, reference_answer, course_id}
entry, which `run_answer_eval.py` then scores. This turns real usage into your eval set.

    python -m eval.build_goldenset_from_feedback --course <uuid> --out eval/data/goldenset_feedback.jsonl
    python -m eval.build_goldenset_from_feedback            # all courses
"""
from __future__ import annotations

import argparse
import json

from .db import connect

# For each 👍'd assistant message, grab the immediately-preceding user question.
_SQL = """
SELECT c.course_id,
       m.content AS answer,
       (SELECT um.content
          FROM messages um
         WHERE um.conversation_id = m.conversation_id
           AND um.role = 'user'
           AND um.created_at < m.created_at
         ORDER BY um.created_at DESC
         LIMIT 1) AS question
FROM message_feedback f
JOIN messages m       ON m.id = f.message_id
JOIN conversations c  ON c.id = m.conversation_id
WHERE f.rating = 'up'
  AND (%s IS NULL OR c.course_id = %s)
"""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--course", default=None, help="course_id filter (optional)")
    ap.add_argument("--out", default="eval/data/goldenset_feedback.jsonl")
    args = ap.parse_args()

    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(_SQL, (args.course, args.course))
            rows = cur.fetchall()

    n = 0
    with open(args.out, "w") as fh:
        for course_id, answer, question in rows:
            if not question or not answer:
                continue
            fh.write(
                json.dumps(
                    {
                        "question": question,
                        "reference_answer": answer,
                        "course_id": str(course_id),
                    }
                )
                + "\n"
            )
            n += 1

    print(f"wrote {n} golden entries (from 👍 feedback) to {args.out}")
    if n == 0:
        print("(no up-voted answers yet — collect feedback first)")


if __name__ == "__main__":
    main()
