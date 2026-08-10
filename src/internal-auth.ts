import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time secret comparison.
 *
 * Both sides are hashed first so the buffers are always the same length:
 * timingSafeEqual throws on a length mismatch, and handling that would leak the
 * expected secret's length through the error path.
 */
export function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export type AuthDecision =
  | { ok: true }
  | { ok: false; status: 401 | 503; body: { error: string } };

/**
 * Decide whether an internal request is authorised. Fails CLOSED.
 *
 * This logic previously read `if (secret && auth !== expected)`, which meant an
 * empty INTERNAL_JWT_SECRET disabled authentication entirely instead of denying
 * everything. The agent is publicly reachable on Railway, so one missed env var
 * would have exposed every endpoint — including ones that spend OpenAI credits
 * and read other users' course material. Env syncing has silently dropped
 * variables before (see the Vercel sync fix), so that is a realistic
 * misconfiguration rather than a theoretical one.
 *
 * A missing secret yields 503, not 401: the service is misconfigured, and 401
 * would wrongly imply the caller could fix it by presenting a credential.
 *
 * Split out of server.ts so it can be tested without booting an HTTP listener.
 */
export function decideInternalAuth(
  authorizationHeader: string | undefined,
  expectedSecret: string,
): AuthDecision {
  if (!expectedSecret) {
    return { ok: false, status: 503, body: { error: "server misconfigured" } };
  }
  if (!secretsMatch(authorizationHeader ?? "", `Bearer ${expectedSecret}`)) {
    return { ok: false, status: 401, body: { error: "unauthorized" } };
  }
  return { ok: true };
}
