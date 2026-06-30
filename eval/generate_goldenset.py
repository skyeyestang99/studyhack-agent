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
from dataclasses import dataclass


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
    # TODO: SELECT id, material_id, course_id, content FROM material_chunks
    #       (optionally limit per course). Reuse the agent's DB client.
    raise NotImplementedError("Wire to material_chunks.")


def gen_qa(chunk: Chunk, n: int) -> list[dict]:
    # TODO: call OpenAI (gpt-4o-mini) with QA_PROMPT.format(n=n, content=chunk.content),
    #       parse JSON, and (optionally) self-rate answerability to filter weak items.
    raise NotImplementedError("Wire to OpenAI.")


def build(out_path: str, per_chunk: int) -> int:
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
