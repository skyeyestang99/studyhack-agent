import pgvector from "pgvector/pg";
import { pool } from "./db.js";
import { embedBatch } from "./ingest/embed.js";

export interface RetrievedChunk {
  chunkId: string;
  materialId: string;
  courseId: string | null;
  content: string;
  fileName: string;
  page?: number;
  score: number; // cosine similarity (1 - distance)
}

interface Row {
  id: string;
  material_id: string;
  course_id: string;
  content: string;
  file_name: string;
  page: number | null;
  distance: number;
}

/**
 * Course-scoped ANN retrieval over shared chunks. The scope filter is a
 * deterministic DB predicate (never the LLM) — only chunks for `courseId`
 * are returned, which is also the isolation guarantee the eval harness checks.
 * Joins `materials` for citation provenance (fileName).
 *
 * `hnsw.iterative_scan` (pgvector >= 0.8) is essential here: a selective
 * `course_id` filter otherwise starves the HNSW candidate set (the index pulls
 * the globally-nearest ef_search chunks, then the filter removes them all →
 * zero rows). Iterative scans re-scan to refill the LIMIT after filtering, so
 * course-filtered retrieval stays correct as the multi-class pool grows.
 */
export async function retrieve(
  question: string,
  courseId: string,
  k = 5,
): Promise<RetrievedChunk[]> {
  const [embedding] = await embedBatch([question]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL hnsw.iterative_scan = 'relaxed_order'");
    const res = await client.query<Row>(
      `SELECT mc.id, mc.material_id, mc.course_id, mc.content, m.file_name, mc.page,
              mc.embedding <=> $1 AS distance
       FROM material_chunks mc
       JOIN materials m ON m.id = mc.material_id
       WHERE m.deleted_at IS NULL
         AND mc.scope = 'shared' AND mc.course_id = $2
       ORDER BY mc.embedding <=> $1
       LIMIT $3`,
      [pgvector.toSql(embedding), courseId, k],
    );
    await client.query("COMMIT");
    return res.rows.map((r) => ({
      chunkId: r.id,
      materialId: r.material_id,
      courseId: r.course_id,
      content: r.content,
      fileName: r.file_name,
      page: r.page ?? undefined,
      score: 1 - Number(r.distance),
    }));
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
