export interface Chunk {
  index: number;
  content: string;
  approxTokens: number;
}

/** Rough token estimate (words * 1.3). Swap for js-tiktoken if exact counts matter. */
export function approxTokens(s: string): number {
  const words = s.trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.3);
}

/**
 * Split text into ~targetTokens chunks with token overlap, preferring sentence /
 * paragraph boundaries. Pure + deterministic — unit-testable without any I/O.
 */
export function chunkText(text: string, targetTokens = 500, overlapTokens = 50): Chunk[] {
  const clean = text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
  if (!clean) return [];

  const units = clean
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map((u) => u.trim())
    .filter(Boolean);

  const chunks: Chunk[] = [];
  let buf: string[] = [];
  let bufTokens = 0;

  const flush = () => {
    if (buf.length === 0) return;
    const content = buf.join(" ").trim();
    chunks.push({ index: chunks.length, content, approxTokens: approxTokens(content) });
  };

  for (const unit of units) {
    const t = approxTokens(unit);
    if (bufTokens + t > targetTokens && buf.length > 0) {
      flush();
      // carry trailing units as overlap
      const carry: string[] = [];
      let carryTokens = 0;
      for (let i = buf.length - 1; i >= 0 && carryTokens < overlapTokens; i--) {
        carry.unshift(buf[i]);
        carryTokens += approxTokens(buf[i]);
      }
      buf = carry;
      bufTokens = carryTokens;
    }
    buf.push(unit);
    bufTokens += t;
  }
  flush();
  return chunks;
}
