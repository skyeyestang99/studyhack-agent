import OpenAI from "openai";
import { config } from "../config.js";

const client = new OpenAI({ apiKey: config.openaiApiKey });

/** Batch-embed texts with the configured model (text-embedding-3-small, 1536-d). */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (!config.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is required for material embeddings.");
  }
  const res = await client.embeddings.create({
    model: config.embeddingModel,
    input: texts,
  });
  return res.data.map((d) => d.embedding as number[]);
}
