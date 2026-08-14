import { createHash } from "node:crypto";
import { config } from "./config.js";
import {
  EXAM_INSIGHTS_SYSTEM,
  OCR_PROMPT,
  STUDY_TOOL_PROMPTS,
  TUTOR_CHAT_SYSTEM,
} from "./prompts.js";

/**
 * Every knob that can change what the model produces, in one place.
 *
 * Iteration B needs this for a specific reason: an eval result is meaningless without
 * knowing what it evaluated. Model, temperature, retrieval depth and the prompts are
 * all part of "what the AI does", and they were scattered across generate.ts, study.ts,
 * exam-insights.ts, verify.ts, syllabus.ts and ocr.ts — six files, any of which could
 * change the product's behaviour without the eval baseline noticing.
 *
 * `aiConfigHash` is stamped into every eval report so a recorded baseline is tied to a
 * specific configuration. A passing baseline from a different hash is not evidence
 * about the current one.
 *
 * IMPORTANT: only include things that actually affect output. Adding something
 * cosmetic here makes the hash churn and destroys its value as a signal.
 */

/** Where each AI surface's behaviour is defined. Keys are stable identifiers. */
export type AiSurface =
  | "tutor_chat"
  | "quick_help"
  | "exam_insights"
  | "study_tool"
  | "syllabus_extract"
  | "verify_claim"
  | "ocr";

export interface SurfaceConfig {
  /** Chat model used by this surface. */
  model: string;
  /** Undefined means "provider default" — recorded as such rather than guessed. */
  temperature?: number;
  /** Retrieved chunks fed to the prompt; 0 for surfaces that do not retrieve. */
  retrievalK: number;
}

export const AI: Record<AiSurface, SurfaceConfig> = {
  // Course-scoped tutoring: grounded in the student's own materials.
  tutor_chat: { model: config.chatModel, retrievalK: 5 },
  // Zero-setup help. retrievalK 0 is the defining property: there is no course, so an
  // answer here must never claim to come from the student's materials.
  quick_help: { model: config.chatModel, retrievalK: 0 },
  // Reads the WHOLE assessment corpus rather than a ranked subset, so k is not a knob.
  exam_insights: { model: config.chatModel, retrievalK: 0 },
  study_tool: { model: config.chatModel, retrievalK: 12 },
  syllabus_extract: { model: config.chatModel, retrievalK: 0 },
  verify_claim: { model: config.chatModel, retrievalK: 0 },
  ocr: { model: config.chatModel, retrievalK: 0 },
};

export const EMBEDDING = {
  model: config.embeddingModel,
  dimensions: config.embeddingDim,
} as const;

export const CHUNKING = {
  targetTokens: config.chunk.targetTokens,
  overlapTokens: config.chunk.overlapTokens,
} as const;

/**
 * Prompt fingerprints, derived by importing the prompts directly.
 *
 * NOT a side-effect registry. The first version had each surface call registerPrompt()
 * on import, which made the hash depend on which modules the current process happened
 * to load — complete under server.ts, empty in a test that only imported the retriever.
 * A hash that varies by import graph cannot identify a baseline.
 *
 * Digests rather than full text: the hash should change when wording changes without
 * carrying kilobytes of prompt around.
 */
const PROMPT_TEXT: Record<string, string> = {
  tutor_chat: TUTOR_CHAT_SYSTEM,
  exam_insights: EXAM_INSIGHTS_SYSTEM,
  ocr: OCR_PROMPT,
  study_tool: Object.values(STUDY_TOOL_PROMPTS).join("\n"),
};

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export function promptFingerprints(): Record<string, string> {
  return Object.fromEntries(
    Object.keys(PROMPT_TEXT)
      .sort()
      .map((k) => [k, digest(PROMPT_TEXT[k])]),
  );
}

/**
 * Stable hash of everything that affects model output.
 *
 * Sorted keys so the hash depends on values rather than on object literal order, and
 * prompt digests rather than prompt text so the hash is short but still changes when
 * wording changes.
 */
export function aiConfigHash(): string {
  const material = JSON.stringify({
    surfaces: Object.fromEntries(
      (Object.keys(AI) as AiSurface[]).sort().map((k) => [k, AI[k]]),
    ),
    embedding: EMBEDDING,
    chunking: CHUNKING,
    prompts: promptFingerprints(),
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/** Full snapshot for an eval report — the hash alone does not say what changed. */
export function aiConfigSnapshot() {
  return {
    hash: aiConfigHash(),
    surfaces: AI,
    embedding: EMBEDDING,
    chunking: CHUNKING,
    prompts: promptFingerprints(),
  };
}
