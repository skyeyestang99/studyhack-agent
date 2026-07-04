"""Course-scoped pgvector retriever for the eval harness.

Mirrors the agent's `retrieve.ts` query so eval measures the real retrieval
approach (chunking + embedding + course-scoped ANN) without running the agent.
"""
import numpy as np

from .db import connect
from .embed import embed
from .retriever import RetrievedChunk


class PgvectorRetriever:
    def retrieve(self, question: str, course_id: str, k: int = 5) -> list[RetrievedChunk]:
        q = np.asarray(embed([question])[0], dtype=np.float32)
        with connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """SELECT id, material_id, course_id, embedding <=> %s AS distance
                       FROM material_chunks
                       WHERE scope = 'shared' AND course_id = %s
                       ORDER BY embedding <=> %s
                       LIMIT %s""",
                    (q, course_id, q, k),
                )
                rows = cur.fetchall()
        return [
            RetrievedChunk(chunk_id=str(r[0]), course_id=str(r[2]), score=1 - float(r[3]))
            for r in rows
        ]
