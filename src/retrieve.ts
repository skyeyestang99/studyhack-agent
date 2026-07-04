import pgvector from "pgvector/pg";
import { query } from "./db.js";
import { embedBatch } from "./ingest/embed.js";

export interface RetrievedChunk {
  chunkId: string;
  materialId: string;
  courseId: string | null;
  content: string;
  score: number; // cosine similarity (1 - distance)
}

/**
 * Course-scoped ANN retrieval over shared chunks. The scope filter is a
 * deterministic DB predicate (never the LLM) — only chunks for `courseId`
 * are returned, which is also the isolation guarantee the eval harness checks.
 */
export async function retrieve(
  question: string,
  courseId: string,
  k = 5,
): Promise<RetrievedChunk[]> {
  const [embedding] = await embedBatch([question]);
  const rows = await query<{
    id: string;
    material_id: string;
    course_id: string;
    content: string;
    distance: number;
  }>(
    `SELECT id, material_id, course_id, content, embedding <=> $1 AS distance
     FROM material_chunks
     WHERE scope = 'shared' AND course_id = $2
     ORDER BY embedding <=> $1
     LIMIT $3`,
    [pgvector.toSql(embedding), courseId, k],
  );
  return rows.map((r) => ({
    chunkId: r.id,
    materialId: r.material_id,
    courseId: r.course_id,
    content: r.content,
    score: 1 - Number(r.distance),
  }));
}
