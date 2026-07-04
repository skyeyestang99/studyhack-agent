"""Generate a retrieval golden set from the seed corpus.

For each chunk, ask an LLM for question->answer pairs whose answer is grounded
in THAT chunk, producing labels:
    {question, source_chunk_id, source_material_id, course_id, reference_answer}

Scaffold: wire `load_chunks()` to the `material_chunks` table and `gen_qa()` to
OpenAI. Output is JSONL tagged with corpus hash + model for reproducibility.

    python -m eval.generate_goldenset --out eval/data/goldenset.jsonl --per-chunk 2
"""
from __future__ import annotations

import argparse
import json
import os
import re
from dataclasses import dataclass

from dotenv import load_dotenv
from openai import OpenAI

from .db import connect

load_dotenv()
_client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))


@dataclass
class Chunk:
    chunk_id: str
    material_id: str
    course_id: str
    content: str


QA_PROMPT = """You are creating an exam-style question to test a retrieval system.
Given this study-material excerpt, write {n} self-contained question(s) whose answer
is fully contained in the excerpt, plus a concise reference answer. Avoid questions
that need outside knowledge. Return JSON: [{{"question": "...", "answer": "..."}}].

EXCERPT:
{content}
"""


def load_chunks() -> list[Chunk]:
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT mc.id, mc.material_id, mc.course_id, mc.content
                   FROM material_chunks mc
                   JOIN materials m ON m.id = mc.material_id
                   WHERE m.owner_user_id = 'seed-system' AND mc.scope = 'shared'
                   ORDER BY mc.material_id, mc.chunk_index"""
            )
            return [
                Chunk(chunk_id=str(r[0]), material_id=str(r[1]), course_id=str(r[2]), content=r[3])
                for r in cur.fetchall()
            ]


def gen_qa(chunk: Chunk, n: int) -> list[dict]:
    res = _client.chat.completions.create(
        model="gpt-4o-mini",
        temperature=0.3,
        messages=[{"role": "user", "content": QA_PROMPT.format(n=n, content=chunk.content)}],
    )
    text = res.choices[0].message.content.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.MULTILINE).strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\[.*\]", text, re.S)
        data = json.loads(m.group(0)) if m else []
    return [
        {"question": d["question"], "answer": d["answer"]}
        for d in data
        if isinstance(d, dict) and d.get("question") and d.get("answer")
    ]


def build(out_path: str, per_chunk: int) -> int:
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    written = 0
    with open(out_path, "w") as f:
        for chunk in load_chunks():
            for qa in gen_qa(chunk, per_chunk):
                f.write(json.dumps({
                    "question": qa["question"],
                    "reference_answer": qa["answer"],
                    "source_chunk_id": chunk.chunk_id,
                    "source_material_id": chunk.material_id,
                    "course_id": chunk.course_id,
                }) + "\n")
                written += 1
    return written


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="eval/data/goldenset.jsonl")
    ap.add_argument("--per-chunk", type=int, default=2)
    args = ap.parse_args(argv)
    n = build(args.out, args.per_chunk)
    print(f"wrote {n} golden items -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
