import { pdf } from "pdf-to-img";
import OpenAI from "openai";
import { config } from "../config.js";

const client = new OpenAI({ apiKey: config.openaiApiKey });

// Cap pages so a huge scan doesn't run up unbounded vision cost/time.
const OCR_MAX_PAGES = Number(process.env.OCR_MAX_PAGES ?? 15);

const OCR_PROMPT =
  "Transcribe ALL text from this page exactly as written, preserving structure, " +
  "lists, and any mathematics (use LaTeX with $…$ / $$…$$ for formulas). " +
  "Output only the transcription — no commentary.";

/**
 * OCR a scanned/image PDF: rasterize each page to a PNG (pdf-to-img →
 * @napi-rs/canvas, prebuilt binaries — no system deps) and transcribe it with a
 * vision model. Used as the fallback when a PDF has no extractable text layer.
 */
export async function ocrPdf(bytes: Buffer): Promise<string> {
  const document = await pdf(bytes, { scale: 2 });
  const pages: string[] = [];
  let n = 0;
  for await (const image of document) {
    if (n >= OCR_MAX_PAGES) break;
    n++;
    const dataUrl = `data:image/png;base64,${image.toString("base64")}`;
    const res = await client.chat.completions.create({
      model: config.chatModel,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: OCR_PROMPT },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    });
    const text = res.choices[0]?.message?.content?.trim();
    if (text) pages.push(text);
  }
  return pages.join("\n\n");
}
