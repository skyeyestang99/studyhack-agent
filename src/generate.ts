import OpenAI from "openai";
import { config } from "./config.js";

const client = new OpenAI({ apiKey: config.openaiApiKey });

const SYSTEM = `You are StudyHack, a Socratic homework tutor. Ground your answer ONLY in the
provided course materials. If they do not contain the answer, say so plainly rather than guessing.
Structure every answer as:
**Approach** — how to think about the problem (guide; do not just hand over the final answer).
**Solution** — the worked steps.
**Key Takeaways** — the concepts worth remembering.
Never fabricate facts beyond the provided materials.

Format ALL mathematics with KaTeX-compatible dollar delimiters so it renders:
inline math in single dollars (e.g. $\\frac{dy}{dx} = g(x)h(y)$) and display equations
in double dollars on their own line (e.g. $$\\int \\frac{1}{h(y)}\\,dy = \\int g(x)\\,dx$$).
Never write bare or bracket-delimited LaTeX like \\arctan(y) or [ \\int ... ] outside dollar signs.`;

export interface ContextChunk {
  content: string;
  fileName: string;
}

/** Stream a grounded answer as text deltas. */
export async function* generate(
  question: string,
  context: ContextChunk[],
): AsyncIterable<string> {
  const grounding = context.length
    ? context.map((c, i) => `[${i + 1}] (${c.fileName})\n${c.content}`).join("\n\n")
    : "(no relevant course materials found)";

  const stream = await client.chat.completions.create({
    model: config.chatModel,
    stream: true,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: `Course materials:\n${grounding}\n\nQuestion: ${question}` },
    ],
  });

  for await (const part of stream) {
    const delta = part.choices[0]?.delta?.content;
    if (delta) yield delta;
  }
}
