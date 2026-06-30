"""The seam where the real agent retriever plugs into the eval harness."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass
class RetrievedChunk:
    chunk_id: str
    course_id: str
    score: float = 0.0


class Retriever(Protocol):
    """A course-scoped retriever. Implementations MUST apply scope filtering
    (only return chunks the querying course/user is allowed to see) so the
    isolation metric is meaningful."""

    def retrieve(self, question: str, course_id: str, k: int) -> list[RetrievedChunk]:
        ...


class DummyRetriever:
    """In-memory retriever to test the harness without the real pipeline.
    `responses` maps a question -> ordered list of RetrievedChunk."""

    def __init__(self, responses: dict[str, list[RetrievedChunk]]):
        self._responses = responses

    def retrieve(self, question: str, course_id: str, k: int = 5) -> list[RetrievedChunk]:
        return self._responses.get(question, [])[:k]
