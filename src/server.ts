import Fastify from "fastify";
import { config } from "./config.js";
import { retrieve } from "./retrieve.js";
import { generate } from "./generate.js";

const app = Fastify({ logger: true });

app.get("/health", async () => ({ ok: true }));

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

  const { question, courseId, k } = (req.body ?? {}) as {
    question?: string;
    courseId?: string;
    k?: number;
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
    const chunks = await retrieve(question, courseId, k ?? 5);
    for await (const token of generate(
      question,
      chunks.map((c) => ({ content: c.content, fileName: c.fileName })),
    )) {
      send({ type: "token", content: token });
    }
    // One citation per distinct source material (Doc 05 §4 contract).
    const seen = new Set<string>();
    for (const c of chunks) {
      if (seen.has(c.materialId)) continue;
      seen.add(c.materialId);
      send({
        type: "citation",
        materialId: c.materialId,
        fileName: c.fileName,
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

app
  .listen({ port: config.port, host: "0.0.0.0" })
  .then(() => console.log(`agent listening on :${config.port}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
