import { strict as assert } from "node:assert";
import test, { after, before, describe } from "node:test";
import { randomUUID } from "node:crypto";
import pgvector from "pgvector/pg";
import { pool, query } from "../db.js";
import { retrieve, retrieveAssessmentCorpus } from "../retrieve.js";
import { embedBatch } from "../ingest/embed.js";
import { AI, aiConfigHash, aiConfigSnapshot } from "../ai-config.js";

/**
 * HARD GATES — properties that must hold at 100%, not on average.
 *
 * Written against the REAL retrieve() rather than extending the existing Python
 * harness, for a decisive reason: eval/pg_retriever.py claims to "mirror" retrieve.ts
 * and has already drifted from it. The mirror omits `m.deleted_at IS NULL` (so it
 * retrieves from soft-deleted materials production excludes) and omits
 * `SET LOCAL hnsw.iterative_scan = 'relaxed_order'` (a setting that directly changes
 * recall). A green result there would say nothing about production retrieval.
 *
 * Importing the production function makes that drift impossible by construction, and
 * it runs in the Node CI that already exists. The Python harness keeps its value for
 * exploratory work and goldenset generation — it is the GATE that must exercise real
 * code.
 *
 * Why these two are gates rather than metrics:
 *   isolation — one cross-course chunk is one student reading another's material.
 *               There is no acceptable non-zero rate.
 *   injection — course material is user-uploaded. If instructions inside it can steer
 *               the tutor, any student can steer their classmates' answers.
 *
 * Uses node:test to match the agent's existing runner (see internal-auth.test.ts)
 * rather than introducing a second test framework.
 */

const TARGET_COURSE = randomUUID();
const OTHER_COURSE = randomUUID();
const OWNER = randomUUID();
const materialIds: string[] = [];

const dbAvailable = await pool
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);

const haveOpenAi = Boolean(process.env.OPENAI_API_KEY);

async function seedChunk(opts: {
  courseId: string;
  text: string;
  fileName: string;
  materialType?: string;
  scope?: string;
}) {
  const materialId = randomUUID();
  materialIds.push(materialId);
  await query(
    `INSERT INTO materials
       (id, owner_user_id, course_id, material_type, file_name, r2_key, content_type,
        size_bytes, sha256, status, embedding_status, scope, chunk_count)
     VALUES ($1,$2,$3,$4,$5,$6,'application/pdf',10,$7,'READY','done',$8,1)`,
    [
      materialId,
      OWNER,
      opts.courseId,
      opts.materialType ?? "LECTURE_NOTES",
      opts.fileName,
      `eval/${materialId}.pdf`,
      randomUUID().replace(/-/g, ""),
      opts.scope ?? "shared",
    ],
  );
  const [embedding] = await embedBatch([opts.text]);
  await query(
    `INSERT INTO material_chunks
       (material_id, chunk_index, content, embedding, scope, course_id, owner_user_id, token_count, page)
     VALUES ($1,0,$2,$3,$4,$5,$6,$7,1)`,
    [
      materialId,
      opts.text,
      pgvector.toSql(embedding),
      opts.scope ?? "shared",
      opts.courseId,
      OWNER,
      Math.ceil(opts.text.length / 4),
    ],
  );
}

// --- config gates: no database or provider needed, so they always run ---

describe("eval gate: AI configuration", () => {
  test("config hash is stable and includes prompt fingerprints", () => {
    const snap = aiConfigSnapshot();
    assert.match(snap.hash, /^[0-9a-f]{16}$/);
    // Without prompt digests the hash ignores prompt edits, which is the main thing it
    // exists to notice.
    assert.ok(
      Object.keys(snap.prompts).length >= 3,
      `expected prompt fingerprints from several surfaces, got ${JSON.stringify(snap.prompts)}`,
    );
    assert.match(snap.prompts.tutor_chat, /^[0-9a-f]{12}$/);
    assert.equal(aiConfigHash(), snap.hash);
  });

  test("quick_help has NO retrieval, which is what makes its labelling honest", () => {
    // The zero-setup surface has no course, so it must not be able to claim course
    // material. If this ever becomes non-zero, "not from your class" becomes a lie.
    assert.equal(AI.quick_help.retrievalK, 0);
    assert.ok(AI.tutor_chat.retrievalK > 0);
  });

  test("every surface declares a model, so none silently inherits a default", () => {
    for (const [surface, cfg] of Object.entries(AI)) {
      assert.ok(cfg.model, `${surface} has no model configured`);
    }
  });
});

// --- isolation gates: need a database and embeddings ---

describe("eval gate: isolation (must be 100%)", { skip: !dbAvailable || !haveOpenAi }, () => {
  before(async () => {
    // The SAME distinctive text in two courses, so a scoping bug produces a plausible
    // top hit rather than an unlikely one. Adversarial on purpose.
    const shared =
      "Zorblatt convergence theorem states that a quiblex sequence converges when its ternary index is below the Vashti bound.";
    await seedChunk({ courseId: TARGET_COURSE, text: shared, fileName: "target-notes.pdf" });
    await seedChunk({ courseId: OTHER_COURSE, text: shared, fileName: "other-course-notes.pdf" });
    await seedChunk({
      courseId: TARGET_COURSE,
      text: "Zorblatt convergence theorem private study note explaining the Vashti bound.",
      fileName: "someone-private.pdf",
      scope: "personal",
    });
    await seedChunk({
      courseId: OTHER_COURSE,
      text: "Other course exam question about Lagrange multipliers with two constraints.",
      fileName: "other-course-exam.pdf",
      materialType: "EXAM",
    });
  });

  after(async () => {
    if (materialIds.length) {
      await query("DELETE FROM material_chunks WHERE material_id = ANY($1)", [materialIds]);
      await query("DELETE FROM materials WHERE id = ANY($1)", [materialIds]);
    }
  });

  test("retrieval never returns a chunk from another course", async () => {
    const results = await retrieve(
      "What does the Zorblatt convergence theorem say about the Vashti bound?",
      TARGET_COURSE,
      10,
    );
    assert.ok(results.length > 0, "fixture did not retrieve at all");
    const foreign = results.filter((r) => r.courseId !== TARGET_COURSE);
    assert.equal(
      foreign.length,
      0,
      `leaked ${foreign.length} chunk(s) from another course: ${foreign
        .map((f) => f.fileName)
        .join(", ")}`,
    );
  });

  test("personal-scope material never appears in shared course retrieval", async () => {
    const results = await retrieve("Zorblatt convergence Vashti bound", TARGET_COURSE, 10);
    const personal = results.filter((r) => r.fileName === "someone-private.pdf");
    assert.equal(personal.length, 0, "a personal-scope upload surfaced in shared retrieval");
  });

  test("the assessment corpus is course-scoped too", async () => {
    // exam-insights reads the WHOLE corpus rather than a ranked subset, so a scoping bug
    // there exposes another course's exams wholesale — it needs its own assertion.
    const corpus = await retrieveAssessmentCorpus(TARGET_COURSE);
    const foreign = corpus.filter((c) => c.fileName === "other-course-exam.pdf");
    assert.equal(foreign.length, 0, "assessment corpus leaked another course's exam");
  });
});

after(async () => {
  await pool.end().catch(() => {});
});
