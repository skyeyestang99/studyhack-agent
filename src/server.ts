import { initSentry, Sentry } from "./instrument.js";
initSentry();

import Fastify from "fastify";
import { config } from "./config.js";
import { decideInternalAuth } from "./internal-auth.js";
import { retrieve, retrieveForStudyGuide } from "./retrieve.js";
import { generate, type HistoryMessage } from "./generate.js";
import {
  generateStudyTool,
  generateFlashcards,
  generateStructuredStudyGuide,
  reviseStructuredStudyGuide,
  type StudyToolKind,
} from "./study.js";
import { extractClaim, verifyClaim, looksComputational } from "./verify.js";
import { ingestMaterial, ingestPending } from "./ingest/pipeline.js";
import { generateExamInsights } from "./exam-insights.js";

const app = Fastify({ logger: true });

// Official Sentry Fastify error handler (no-op if SENTRY_DSN unset, since
// Sentry.init was never called). Captures request-scoped errors with full
// route/method context - richer than a manual onError hook, and pairs with
// the fastifyIntegration() tracing added in instrument.ts for the
// request-volume/latency/error dashboard.
if (config.sentryDsn) Sentry.setupFastifyErrorHandler(app);

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

/**
 * Guard for every internal endpoint. Fails CLOSED — see internal-auth.ts for why
 * that matters and what the previous behaviour was.
 */
function checkInternalAuth(
  req: { headers: { authorization?: string } },
  reply: { code: (status: number) => { send: (body: unknown) => unknown } },
) {
  const decision = decideInternalAuth(req.headers.authorization, config.internalSecret);
  if (decision.ok) return null;
  if (decision.status === 503) {
    console.error("SECURITY: INTERNAL_JWT_SECRET is not set — refusing request");
  }
  return reply.code(decision.status).send(decision.body);
}

function toStudyGuideSources(chunks: Awaited<ReturnType<typeof retrieveForStudyGuide>>) {
  return chunks
    .filter((chunk) => chunk.score >= CITATION_MIN_SCORE)
    .map((chunk, index) => ({
      ref: `S${index + 1}`,
      materialId: chunk.materialId,
      page: chunk.page,
      snippet: chunk.content.slice(0, 1200),
      score: chunk.score,
      content: chunk.content,
      fileName: chunk.fileName,
    }));
}

/** Generate grounded flashcards (JSON) from course materials. Shared-secret auth. */
app.post("/flashcards", async (req, reply) => {
  const authError = checkInternalAuth(req, reply);
  if (authError) return authError;
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

app.post("/study-guide/generate", async (req, reply) => {
  const authError = checkInternalAuth(req, reply);
  if (authError) return authError;
  const { userId, courseId, target, retrievalMode } = (req.body ?? {}) as {
    userId?: string;
    courseId?: string;
    target?: string;
    retrievalMode?: "personal" | "course";
  };
  if (!userId || !courseId || !target || (retrievalMode !== "personal" && retrievalMode !== "course")) {
    return reply.code(400).send({ error: "userId, courseId, target, and retrievalMode are required" });
  }
  const chunks = await retrieveForStudyGuide(target, {
    userId,
    courseId,
    retrievalMode,
    k: 20,
    minScore: CITATION_MIN_SCORE,
  });
  const sources = toStudyGuideSources(chunks);
  return generateStructuredStudyGuide({ target, retrievalMode }, sources);
});

app.post("/study-guide/revise", async (req, reply) => {
  const authError = checkInternalAuth(req, reply);
  if (authError) return authError;
  const { userId, courseId, retrievalMode, instruction, concepts } = (req.body ?? {}) as {
    userId?: string;
    courseId?: string;
    retrievalMode?: "personal" | "course";
    instruction?: string;
    concepts?: {
      logicalConceptId: string;
      title: string;
      category?: string;
      summary: string;
      keyPoints: string[];
    }[];
  };
  if (
    !userId ||
    !courseId ||
    (retrievalMode !== "personal" && retrievalMode !== "course") ||
    !instruction ||
    !Array.isArray(concepts) ||
    concepts.length === 0
  ) {
    return reply.code(400).send({ error: "userId, courseId, retrievalMode, instruction, and concepts are required" });
  }
  const query = `${instruction}\n${concepts.map((concept) => `${concept.title}\n${concept.summary}`).join("\n")}`;
  const chunks = await retrieveForStudyGuide(query, {
    userId,
    courseId,
    retrievalMode,
    k: 20,
    minScore: CITATION_MIN_SCORE,
  });
  const sources = toStudyGuideSources(chunks);
  return reviseStructuredStudyGuide({ instruction, concepts }, sources);
});

/**
 * Embed a material (or all pending) on demand. Called fire-and-forget by the
 * backend right after upload so the "upload → get help" journey works without
 * a manual `npm run ingest`. Auth: shared-secret Bearer (INTERNAL_JWT_SECRET).
 */
/**
 * Serialize all ingest work within this process. `/ingest` (fire-and-forget from
 * the backend on upload) and the background poller can otherwise run
 * concurrently and double-process the same material — double-charging OpenAI
 * embeddings and over-incrementing embedding_attempts. Observed live: materials
 * reached embedding_attempts=4 despite a `< 3` retry gate, only reachable via
 * concurrent double-processing.
 *
 * NOTE: in-process only. This does NOT protect against two agent instances
 * racing, because ingestPending() still has no DB-level claim (no
 * FOR UPDATE SKIP LOCKED / lease, unlike the study-guide worker). Scaling the
 * agent past one instance requires adding that claim first.
 */
let ingestQueue: Promise<unknown> = Promise.resolve();

function enqueueIngest<T>(task: () => Promise<T>): Promise<T> {
  const run = ingestQueue.catch(() => undefined).then(task);
  ingestQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * "What does this professor actually test?" — aggregate emphasis analysis over
 * the course's own past exams/quizzes/homework. Shared-secret auth like the
 * other internal endpoints.
 */
app.post("/exam-insights", async (req, reply) => {
  const authError = checkInternalAuth(req, reply);
  if (authError) return authError;
  const { courseId } = (req.body ?? {}) as { courseId?: string };
  if (!courseId) return reply.code(400).send({ error: "courseId is required" });
  try {
    return await generateExamInsights(courseId);
  } catch (err) {
    return reply
      .code(500)
      .send({ error: err instanceof Error ? err.message : "exam insights failed" });
  }
});

app.post("/ingest", async (req, reply) => {
  const authError = checkInternalAuth(req, reply);
  if (authError) return authError;
  const { materialId } = (req.body ?? {}) as { materialId?: string };
  try {
    if (materialId) {
      const { chunks } = await enqueueIngest(() => ingestMaterial(materialId));
      return { ok: true, chunks };
    }
    await enqueueIngest(() => ingestPending());
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
  const authError = checkInternalAuth(req, reply);
  if (authError) return authError;

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
  const authError = checkInternalAuth(req, reply);
  if (authError) return authError;
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
// the monthly quota days into the billing cycle).
//
// A fixed interval is the wrong shape here. At any interval shorter than the
// database's idle-suspend window, compute never sleeps; at any interval long
// enough to let it sleep, a missed trigger waits that whole interval. So this
// backs off adaptively instead:
//
//   - work found      -> poll again quickly (drain the queue)
//   - queue empty     -> double the delay, up to IDLE_MAX
//
// The primary ingestion path is the backend's fire-and-forget POST /ingest on
// upload; this loop is only the safety net for a missed or failed trigger.
// Idle cost therefore matters far more than idle latency.
const INGEST_ACTIVE_MS = Number(process.env.INGEST_ACTIVE_POLL_MS ?? 15_000); // draining
const INGEST_IDLE_MIN_MS = Number(process.env.INGEST_IDLE_MIN_POLL_MS ?? 60_000); // 1 min
const INGEST_IDLE_MAX_MS = Number(process.env.INGEST_IDLE_MAX_POLL_MS ?? 1_800_000); // 30 min

let ingestDelay = INGEST_IDLE_MIN_MS;
let ingestTimer: NodeJS.Timeout | undefined;

async function ingestTick(): Promise<void> {
  try {
    const claimed = await enqueueIngest(() => ingestPending());
    if (claimed > 0) {
      // There was work; there may be more queued behind it.
      ingestDelay = INGEST_ACTIVE_MS;
    } else {
      // Empty queue: back off so the DB compute can idle/suspend.
      ingestDelay = Math.min(Math.max(ingestDelay * 2, INGEST_IDLE_MIN_MS), INGEST_IDLE_MAX_MS);
    }
  } catch (err) {
    app.log.error({ err }, "embed worker poll failed");
    if (config.sentryDsn) Sentry.captureException(err);
    // Treat errors like an empty queue so a persistent failure (e.g. the DB
    // being unreachable) backs off instead of hammering every interval.
    ingestDelay = Math.min(Math.max(ingestDelay * 2, INGEST_IDLE_MIN_MS), INGEST_IDLE_MAX_MS);
  } finally {
    ingestTimer = setTimeout(() => void ingestTick(), ingestDelay);
    ingestTimer.unref();
  }
}

ingestTimer = setTimeout(() => void ingestTick(), INGEST_IDLE_MIN_MS);
ingestTimer.unref();

/**
 * Refuse to boot a deployed instance with no internal secret.
 *
 * The per-request guard already fails closed, but a 503-on-every-request agent
 * is a confusing way to discover a missing env var: the backend surfaces it as a
 * vague upstream failure. Dying at startup makes it a deploy failure with an
 * unambiguous log line instead.
 *
 * Local development is exempt so the agent still runs from a bare checkout.
 */
const isDeployed = config.appEnv === "production" || config.appEnv === "perf";
if (isDeployed && !config.internalSecret) {
  console.error(
    `FATAL: INTERNAL_JWT_SECRET is required in ${config.appEnv}. ` +
      "Every internal endpoint would refuse traffic. Set it and redeploy.",
  );
  process.exit(1);
}

app
  .listen({ port: config.port, host: "0.0.0.0" })
  .then(() => console.log(`agent listening on :${config.port}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
