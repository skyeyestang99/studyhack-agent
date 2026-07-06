"""Answer-quality metrics for the eval harness (Doc 04 extension).

Retrieval eval (run_retrieval_eval.py) measures whether we FIND the right chunks.
This measures whether the ANSWER is trustworthy:
  - faithfulness: is every factual claim supported by the retrieved context?
  - correctness:  does the answer match the reference answer?
  - abstention:   does an out-of-material question get an honest "general" answer?

Uses an LLM judge (same model as the agent). Costs OpenAI calls — run offline / in CI, not per request.
"""
import json
import os
import re

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

_client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
CHAT_MODEL = os.environ.get("CHAT_MODEL", "gpt-4o-mini")

_SYSTEM = (
    "You are StudyHack, a homework tutor. Answer directly and correctly, grounded ONLY in the "
    "provided course materials. If the materials do not cover the question, say so plainly and give "
    "a clearly-labeled general answer under 'General explanation (not from your course materials):'. "
    "Wrap math in $...$."
)


def generate_answer(question: str, contexts: list[str]) -> str:
    """Mirror the agent's grounded generation so eval measures the real behavior."""
    grounding = "\n\n".join(f"[{i + 1}] {c}" for i, c in enumerate(contexts)) or (
        "(no relevant course materials found)"
    )
    res = _client.chat.completions.create(
        model=CHAT_MODEL,
        messages=[
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": f"Course materials:\n{grounding}\n\nQuestion: {question}"},
        ],
    )
    return res.choices[0].message.content or ""


def _judge(system: str, user: str) -> dict:
    res = _client.chat.completions.create(
        model=CHAT_MODEL,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    )
    try:
        return json.loads(res.choices[0].message.content or "{}")
    except json.JSONDecodeError:
        return {}


def judge_faithfulness(contexts: list[str], answer: str) -> bool:
    """Is every factual claim in the answer supported by the context? (labeled-general is exempt)."""
    ctx = "\n\n".join(contexts) or "(none)"
    out = _judge(
        "You check FAITHFULNESS. Is every factual claim in the answer supported by the provided "
        "context? Claims explicitly labeled as general knowledge are exempt. "
        'Respond JSON {"faithful": true|false}.',
        f"Context:\n{ctx}\n\nAnswer:\n{answer}",
    )
    return bool(out.get("faithful", False))


def judge_correctness(question: str, reference: str, answer: str) -> bool:
    """Does the tutor answer reach the same conclusion as the reference answer?"""
    out = _judge(
        "You check CORRECTNESS. Does the tutor answer reach the same correct conclusion as the "
        'reference answer? Respond JSON {"correct": true|false}.',
        f"Question: {question}\n\nReference answer: {reference}\n\nTutor answer: {answer}",
    )
    return bool(out.get("correct", False))


_GENERAL_RE = re.compile(
    r"general explanation|not (found )?in your (uploaded |course )*materials|"
    r"do(?:n't| not) cover|aren't in your materials",
    re.IGNORECASE,
)


def is_general(answer: str) -> bool:
    """Heuristic: did the answer honestly signal it's outside the course materials?"""
    return bool(_GENERAL_RE.search(answer))
