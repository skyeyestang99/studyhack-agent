import pgvector from "pgvector/pg";
import { pool, query } from "./db.js";
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

export interface AssessmentChunk {
  materialId: string;
  fileName: string;
  materialType: string;
  page?: number;
  content: string;
}

/**
 * Fetch ALL assessment material for a course (exams, quizzes, homework), in
 * document order.
 *
 * Deliberately NOT a vector search. "What does this professor actually test" is
 * an aggregate question over a bounded corpus — every past exam matters equally,
 * and similarity ranking against a query would both drop material and bias the
 * result toward whatever phrasing the query used. Assessment material is small
 * relative to lectures (tens of chunks, not thousands), so reading all of it is
 * cheap and correct.
 *
 * Ordering by (file_name, page, chunk_index) keeps each document's reasoning
 * contiguous, which matters because a single exam problem often spans chunks.
 */
export async function retrieveAssessmentCorpus(
  courseId: string,
  options: { limit?: number } = {},
): Promise<AssessmentChunk[]> {
  const rows = await query<{
    material_id: string;
    file_name: string;
    material_type: string;
    page: number | null;
    content: string;
  }>(
    `SELECT mc.material_id, m.file_name, m.material_type, mc.page, mc.content
     FROM material_chunks mc
     JOIN materials m ON m.id = mc.material_id
     WHERE m.deleted_at IS NULL
       AND m.course_id = $1
       AND m.material_type IN ('EXAM', 'HOMEWORK')
       AND m.embedding_status = 'done'
     ORDER BY m.file_name, mc.page NULLS FIRST, mc.chunk_index
     LIMIT $2`,
    [courseId, options.limit ?? 400],
  );
  return rows.map((r) => ({
    materialId: r.material_id,
    fileName: r.file_name,
    materialType: r.material_type,
    page: r.page ?? undefined,
    content: r.content,
  }));
}

export async function retrieveForStudyGuide(
  question: string,
  input: {
    courseId: string;
    userId: string;
    retrievalMode: "personal" | "course";
    k?: number;
    minScore?: number;
  },
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
         AND m.course_id = $2
         AND ($3::text = 'course' OR m.owner_user_id = $4)
       ORDER BY mc.embedding <=> $1
       LIMIT $5`,
      [
        pgvector.toSql(embedding),
        input.courseId,
        input.retrievalMode,
        input.userId,
        input.k ?? 20,
      ],
    );
    await client.query("COMMIT");
    return res.rows
      .map((r) => ({
        chunkId: r.id,
        materialId: r.material_id,
        courseId: r.course_id,
        content: r.content,
        fileName: r.file_name,
        page: r.page ?? undefined,
        score: 1 - Number(r.distance),
      }))
      .filter((chunk) => chunk.score >= (input.minScore ?? 0));
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
