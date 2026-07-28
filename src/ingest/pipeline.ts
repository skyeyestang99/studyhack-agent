import pgvector from "pgvector/pg";
import { pool, query } from "../db.js";
import { getObjectBytes } from "../r2.js";
import { extract } from "./extract.js";
import { chunkText } from "./chunk.js";
import { embedBatch } from "./embed.js";
import { syncSyllabusEvents } from "./syllabus.js";
import { config } from "../config.js";

interface MaterialRow {
  id: string;
  r2_key: string;
  content_type: string | null;
  file_name: string;
  material_type: string;
  course_id: string | null;
  owner_user_id: string;
  scope: string;
}

/**
 * Ingest one material: R2 -> extract -> chunk -> embed -> material_chunks,
 * then flip embedding_status. Idempotent (re-ingest replaces existing chunks).
 */
export async function ingestMaterial(materialId: string): Promise<{ chunks: number }> {
  const [m] = await query<MaterialRow>(
    `SELECT id, r2_key, content_type, file_name, material_type, course_id, owner_user_id, scope
     FROM materials WHERE id = $1 AND deleted_at IS NULL`,
    [materialId],
  );
  if (!m) throw new Error(`material ${materialId} not found`);

  await query("UPDATE materials SET embedding_status='processing' WHERE id=$1", [m.id]);
  try {
    const bytes = await getObjectBytes(m.r2_key);
    const { text, pageTexts } = await extract(bytes, m.content_type ?? "", m.file_name);
    const pages = pageTexts && pageTexts.length ? pageTexts : [text];
    const chunks: { content: string; approxTokens: number; page: number }[] = [];
    pages.forEach((pt, pi) => {
      for (const c of chunkText(pt, config.chunk.targetTokens, config.chunk.overlapTokens)) {
        chunks.push({ content: c.content, approxTokens: c.approxTokens, page: pi + 1 });
      }
    });
    const embeddings = await embedBatch(chunks.map((c) => c.content));

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM material_chunks WHERE material_id=$1", [m.id]);
      for (let i = 0; i < chunks.length; i++) {
        await client.query(
          `INSERT INTO material_chunks
             (material_id, chunk_index, content, embedding, scope, course_id, owner_user_id, token_count, page)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            m.id, i, chunks[i].content, pgvector.toSql(embeddings[i]),
            m.scope, m.course_id, m.owner_user_id, chunks[i].approxTokens, chunks[i].page,
          ],
        );
      }
      await client.query(
        `UPDATE materials SET embedding_status='done', chunk_count=$2, content_text=$3, processed_at=now()
         WHERE id=$1`,
        [m.id, chunks.length, text],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    if (m.material_type === "SYLLABUS" && m.course_id) {
      try {
        const result = await syncSyllabusEvents({
          materialId: m.id,
          userId: m.owner_user_id,
          courseId: m.course_id,
          text,
        });
        console.log(
          `extracted ${result.accepted} syllabus events from ${m.id}; rejected ${result.rejected}`,
        );
      } catch (err) {
        console.error(`failed to extract syllabus events for ${m.id}:`, (err as Error).message);
      }
    }
    return { chunks: chunks.length };
  } catch (err) {
    await query(
      "UPDATE materials SET embedding_status='failed', embedding_attempts=embedding_attempts+1 WHERE id=$1",
      [m.id],
    );
    throw err;
  }
}

const MAX_EMBED_ATTEMPTS = 3;

/** Ingest all materials still pending embedding (or failed under the retry cap). */
export async function ingestPending(limit = 50): Promise<void> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM materials
       WHERE deleted_at IS NULL
         AND (embedding_status = 'pending'
              OR (embedding_status = 'failed' AND embedding_attempts < $2))
     ORDER BY created_at LIMIT $1`,
    [limit, MAX_EMBED_ATTEMPTS],
  );
  for (const r of rows) {
    try {
      const { chunks } = await ingestMaterial(r.id);
      console.log(`ingested ${r.id}: ${chunks} chunks`);
    } catch (err) {
      console.error(`failed ${r.id}:`, (err as Error).message);
    }
  }
}
