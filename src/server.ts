import { initSentry, Sentry } from "./instrument.js";
initSentry();

import Fastify from "fastify";
import { config } from "./config.js";
import { retrieve } from "./retrieve.js";
import { generate, type HistoryMessage } from "./generate.js";
import { generateStudyTool, generateFlashcards, type StudyToolKind } from "./study.js";
import { extractClaim, verifyClaim, looksComputational } from "./verify.js";
import { ingestMaterial, ingestPending } from "./ingest/pipeline.js";

const app = Fastify({ logger: true });

// Report request-scoped errors to Sentry (no-op if SENTRY_DSN unset). Does
// not change the response — Fastify's default error reply still applies.
app.addHook("onError", async (_req, _reply, error) => {
  if (config.sentryDsn) Sentry.captureException(error);
});

// Only cite a source whose best chunk is actually relevant to the question.
// Keeps off-topic answers/refusals from showing spurious "sources" (cosine sim).
const CITATION_MIN_SCORE = 0.35;

// Grounding mode from the top retrieved chunk's similarity → an honest badge.
// grounded = strong material match; partial = weak; general = fallback/no match.
const GROUNDED_MIN_SCORE = 0.45;
const PARTIAL_MIN_SCORE = 0.3;
type GroundingMode = "grounded" | "partial" | "general";
function classifyMode(topScore: number | undefined): GroundingMode {
  if (topScore === undefined) return "general";
  if (topScore >= GROUNDED_MIN_SCORE) return "grounded";
  if (topScore >= PARTIAL_MIN_SCORE) return "partial";
  return "general";
}

app.get("/health", async () => ({ ok: true }));

/** Generate grounded flashcards (JSON) from course materials. Shared-secret auth. */
app.post("/flashcards", async (req, reply) => {
  const auth = req.headers.authorization;
  if (config.internalSecret && auth !== `Bearer ${config.internalSecret}`) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  const { courseId, topic, count } = (req.body ?? {}) as {
    courseId?: string;
    topic?: string;
    count?: number;
  };
  if (!courseId) return reply.code(400).send({ error: "courseId is required" });
  const chunks = await retrieve(topic?.trim() || "key concepts, definitions, and formulas", courseId, 12);
  const cards = await generateFlashcards(
    topic ?? "",
    chunks.map((c) => ({ content: c.content, fileName: c.fileName })),
    Math.min(Math.max(count ?? 10, 1), 30),
  );
  return { cards };
});

/**
 * Embed a material (or all pending) on demand. Called fire-and-forget by the
 * backend right after upload so the "upload → get help" journey works without
 * a manual `npm run ingest`. Auth: shared-secret Bearer (INTERNAL_JWT_SECRET).
 */
app.post("/ingest", async (req, reply) => {
  const auth = req.headers.authorization;
  if (config.internalSecret && auth !== `Bearer ${config.internalSecret}`) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  const { materialId } = (req.body ?? {}) as { materialId?: string };
  try {
    if (materialId) {
      const { chunks } = await ingestMaterial(materialId);
      return { ok: true, chunks };
    }
    await ingestPending();
    return { ok: true };
  } catch (err) {
    return reply.code(500).send({ error: err instanceof Error ? err.message : "ingest failed" });
  }
});

/**
 * Chat: retrieve course-scoped context, generate a grounded answer, stream it
 * as SSE AgentEvents (token / citation / done), matching Doc 05 §4.
 * Auth: shared-secret Bearer (INTERNAL_JWT_SECRET) — internal JWT is the prod upgrade.
 */
app.post("/chat", async (req, reply) => {
  const auth = req.headers.authorization;
  if (config.internalSecret && auth !== `Bearer ${config.internalSecret}`) {
    return reply.code(401).send({ error: "unauthorized" });
  }

  const { question, courseId, k, history, imageDataUrl } = (req.body ?? {}) as {
    question?: string;
    courseId?: string;
    k?: number;
    history?: HistoryMessage[];
    imageDataUrl?: string;
  };
  if (!question || !courseId) {
    return reply.code(400).send({ error: "question and courseId are required" });
  }

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (e: unknown) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);

  try {
    let answerText = "";
    const chunks = await retrieve(question, courseId, k ?? 5);
    const mode = classifyMode(chunks[0]?.score);
    send({
      type: "mode",
      mode,
      topSource: mode === "general" ? undefined : chunks[0]?.fileName,
    });
    for await (const token of generate(
      question,
      chunks.map((c) => ({ content: c.content, fileName: c.fileName })),
      Array.isArray(history) ? history : [],
      imageDataUrl,
    )) {
      answerText += token;
      send({ type: "token", content: token });
    }
    // Best-effort numeric verification of a checkable math claim (no CAS/Python).
    // Only surface a badge when a check actually passes.
    if (looksComputational(answerText)) {
      const claim = await extractClaim(answerText);
      if (claim) {
        const result = verifyClaim(claim);
        if (result.status === "verified") {
          send({ type: "verification", status: "verified", detail: result.detail });
        }
      }
    }
    // One citation per distinct source material, only when actually relevant
    // (Doc 05 §4). Off-topic/ungrounded answers therefore cite nothing.
    const seen = new Set<string>();
    for (const c of chunks) {
      if (c.score < CITATION_MIN_SCORE) continue;
      if (seen.has(c.materialId)) continue;
      seen.add(c.materialId);
      send({
        type: "citation",
        materialId: c.materialId,
        fileName: c.fileName,
        page: c.page,
        score: Number(c.score.toFixed(3)),
        kind: "shared",
      });
    }
    send({ type: "done" });
  } catch (err) {
    send({ type: "error", message: err instanceof Error ? err.message : "agent error" });
  } finally {
    reply.raw.end();
  }
});

/**
 * Study tools: generate a grounded study guide or practice-problem set from the
 * course materials, streamed as SSE (token / citation / done). Reuses the same
 * course-scoped retrieval + citation-relevance gate as /chat.
 */
app.post("/study-tool", async (req, reply) => {
  const auth = req.headers.authorization;
  if (config.internalSecret && auth !== `Bearer ${config.internalSecret}`) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  const { kind, courseId, topic, count, k } = (req.body ?? {}) as {
    kind?: StudyToolKind;
    courseId?: string;
    topic?: string;
    count?: number;
    k?: number;
  };
  if (!courseId || (kind !== "study_guide" && kind !== "practice_problems")) {
    return reply.code(400).send({ error: "courseId and a valid kind are required" });
  }

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (e: unknown) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);

  try {
    // Broader retrieval than chat — a guide/practice set should span the topic.
    const query =
      topic?.trim() || "key concepts, definitions, formulas, and important exam topics";
    const chunks = await retrieve(query, courseId, k ?? 15);
    const mode = classifyMode(chunks[0]?.score);
    send({
      type: "mode",
      mode,
      topSource: mode === "general" ? undefined : chunks[0]?.fileName,
    });
    for await (const token of generateStudyTool(
      kind,
      topic ?? "",
      chunks.map((c) => ({ content: c.content, fileName: c.fileName })),
      count ?? 5,
    )) {
      send({ type: "token", content: token });
    }
    const seen = new Set<string>();
    for (const c of chunks) {
      if (c.score < CITATION_MIN_SCORE) continue;
      if (seen.has(c.materialId)) continue;
      seen.add(c.materialId);
      send({
        type: "citation",
        materialId: c.materialId,
        fileName: c.fileName,
        page: c.page,
        score: Number(c.score.toFixed(3)),
        kind: "shared",
      });
    }
    send({ type: "done" });
  } catch (err) {
    send({ type: "error", message: err instanceof Error ? err.message : "agent error" });
  } finally {
    reply.raw.end();
  }
});

// Background embed worker: a DB-backed queue, acting as a SAFETY NET for the
// fire-and-forget /ingest trigger the backend fires on every upload (see
// materials.ts) — this only needs to catch the rare missed/failed trigger.
//
// IMPORTANT: this poll interval directly drives Neon compute cost. Neon scales
// a database to zero after ~5 min idle; any poll faster than that keeps the
// compute permanently "active" and can burn an entire month's free-tier
// CU-hour budget on an empty queue alone (confirmed root cause of a prod
// outage 2026-07-25 — polling every 20s never let compute idle, exhausting
// the monthly quota days into the billing cycle). Default is deliberately
// slower than the idle timeout so compute can scale to zero between checks.
const INGEST_POLL_MS = Number(process.env.INGEST_POLL_MS ?? 600_000); // 10 min
let ingestRunning = false;
setInterval(async () => {
  if (ingestRunning) return;
  ingestRunning = true;
  try {
    await ingestPending();
  } catch (err) {
    app.log.error({ err }, "embed worker poll failed");
    if (config.sentryDsn) Sentry.captureException(err);
  } finally {
    ingestRunning = false;
  }
}, INGEST_POLL_MS).unref();

app
  .listen({ port: config.port, host: "0.0.0.0" })
  .then(() => console.log(`agent listening on :${config.port}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
