import { create, all } from "mathjs";
import OpenAI from "openai";
import { config } from "./config.js";

const math = create(all, {});
const client = new OpenAI({ apiKey: config.openaiApiKey });

export type Claim =
  | { type: "derivative"; f: string; var?: string; result: string }
  | { type: "integral_definite"; f: string; var?: string; a: number; b: number; result: number }
  | { type: "equation_solution"; equation: string; var?: string; solutions: Array<number | string> }
  | { type: "simplify"; expr: string; result: string; var?: string };

export interface VerifyResult {
  status: "verified" | "failed" | "unchecked";
  detail: string;
}

const approx = (a: number, b: number, tol = 1e-3) =>
  Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol * (1 + Math.abs(b));

const evalAt = (expr: string, v: string, x: number): number =>
  Number(math.evaluate(expr, { [v]: x }));

/** Verify a math claim NUMERICALLY (sample points / numeric integration) — no CAS/Python. */
export function verifyClaim(claim: Claim): VerifyResult {
  const v = claim.var || "x";
  const pts = [-1.3, -0.4, 0.7, 1.6, 2.9];
  try {
    if (claim.type === "derivative") {
      let checked = 0;
      for (const x of pts) {
        const h = 1e-6;
        let fd: number, cl: number;
        try {
          fd = (evalAt(claim.f, v, x + h) - evalAt(claim.f, v, x - h)) / (2 * h);
          cl = evalAt(claim.result, v, x);
        } catch {
          continue;
        }
        if (!Number.isFinite(fd) || !Number.isFinite(cl)) continue;
        if (!approx(fd, cl)) return { status: "failed", detail: `derivative mismatch at ${v}=${x}` };
        checked++;
      }
      return checked >= 2
        ? { status: "verified", detail: `derivative checked at ${checked} points` }
        : { status: "unchecked", detail: "not enough valid sample points" };
    }

    if (claim.type === "integral_definite") {
      const n = 1000;
      const { a, b } = claim;
      const hh = (b - a) / n;
      let s = evalAt(claim.f, v, a) + evalAt(claim.f, v, b);
      for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * evalAt(claim.f, v, a + i * hh);
      const val = (hh / 3) * s;
      return approx(val, claim.result, 1e-2)
        ? { status: "verified", detail: `integral ≈ ${val.toFixed(4)}` }
        : { status: "failed", detail: `integral ${val.toFixed(4)} ≠ claimed ${claim.result}` };
    }

    if (claim.type === "equation_solution") {
      const [lhs, rhs] = claim.equation.split("=");
      let checked = 0;
      for (const raw of claim.solutions) {
        const x = typeof raw === "string" ? Number(math.evaluate(raw)) : raw;
        if (!Number.isFinite(x)) continue;
        const resid = evalAt(lhs, v, x) - (rhs !== undefined ? evalAt(rhs, v, x) : 0);
        if (!approx(resid, 0, 1e-4)) return { status: "failed", detail: `${v}=${x} does not satisfy the equation` };
        checked++;
      }
      return checked >= 1
        ? { status: "verified", detail: "solution(s) satisfy the equation" }
        : { status: "unchecked", detail: "no evaluable solutions" };
    }

    if (claim.type === "simplify") {
      let checked = 0;
      for (const x of pts) {
        let a: number, b: number;
        try {
          a = evalAt(claim.expr, v, x);
          b = evalAt(claim.result, v, x);
        } catch {
          continue;
        }
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        if (!approx(a, b, 1e-4)) return { status: "failed", detail: `expressions differ at ${v}=${x}` };
        checked++;
      }
      return checked >= 2
        ? { status: "verified", detail: "equivalent at sample points" }
        : { status: "unchecked", detail: "not enough valid sample points" };
    }

    return { status: "unchecked", detail: "unsupported claim type" };
  } catch {
    return { status: "unchecked", detail: "evaluation error" };
  }
}

/** Cheap gate: only attempt extraction on answers that look computational. */
export function looksComputational(answer: string): boolean {
  return /\$.+\$/.test(answer) || (/=/.test(answer) && /\d/.test(answer));
}

const EXTRACT_SYSTEM = `Extract a single machine-checkable math claim from a tutoring answer, if one exists.
Return JSON: {"claim": <claim> | null}. Write ALL expressions in PLAIN calculator syntax
(^ power, * multiply, / divide, sin cos tan exp log sqrt, pi, e) — NEVER LaTeX, no \\frac, no $.
Supported claim shapes:
- {"type":"derivative","f":"<expr>","var":"x","result":"<expr>"}
- {"type":"integral_definite","f":"<expr>","var":"x","a":<number>,"b":<number>,"result":<number>}
- {"type":"equation_solution","equation":"<lhs>=<rhs>","var":"x","solutions":[<number or expr>, ...]}
- {"type":"simplify","expr":"<expr>","result":"<expr>","var":"x"}
Only return a claim if the answer states a definitive result of that kind AND you can express it in
calculator syntax. If it's conceptual, a proof, a word-problem, or not cleanly checkable, return {"claim": null}.`;

/** Ask the model to extract a checkable claim (JSON) from the answer, or null. */
export async function extractClaim(answer: string): Promise<Claim | null> {
  try {
    const res = await client.chat.completions.create({
      model: config.chatModel,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: EXTRACT_SYSTEM },
        { role: "user", content: answer.slice(0, 4000) },
      ],
    });
    const parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}");
    return parsed.claim ?? null;
  } catch {
    return null;
  }
}
