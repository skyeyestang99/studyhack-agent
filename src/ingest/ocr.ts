import {
  createIsomorphicCanvasFactory,
  getDocumentProxy,
  renderPageAsImage,
} from "unpdf";
import OpenAI from "openai";
import { config } from "../config.js";

const client = new OpenAI({ apiKey: config.openaiApiKey });

// Cap pages so a huge scan doesn't run up unbounded vision cost/time.
const OCR_MAX_PAGES = Number(process.env.OCR_MAX_PAGES ?? 15);

const OCR_PROMPT =
  "Transcribe ALL text from this page exactly as written, preserving structure, " +
  "lists, and any mathematics (use LaTeX with $…$ / $$…$$ for formulas). " +
  "Output only the transcription — no commentary.";

// @napi-rs/canvas ships prebuilt binaries (no system deps). unpdf renders into it.
const canvasResolver = () => import("@napi-rs/canvas");

/**
 * OCR a scanned/image PDF: rasterize each page to a PNG and transcribe it with
 * a vision model. Used as the fallback when a PDF has no extractable text layer.
 *
 * Rasterization goes through unpdf rather than `pdf-to-img` on purpose:
 * `pdf-to-img` bundles its own `pdfjs-dist`, and two pdfjs versions in one
 * process break BOTH paths (pdfjs registers a process-global worker).
 *
 * The canvas factory must be attached to the DOCUMENT, not just passed to
 * renderPageAsImage. unpdf only wires its factory in when it constructs the
 * document itself:
 *   const pdf = isPDFDocumentProxy(data) ? data : await getDocumentProxy(data, { canvasFactory })
 * so handing it a proxy we built ourselves leaves pdfjs's default, canvas-less
 * factory in place and every render fails with
 * `Cannot read properties of undefined (reading 'createCanvas')`.
 */
export async function ocrPdf(bytes: Buffer): Promise<string> {
  // unpdf types this param as `() => Promise<typeof canvas>`, where `canvas`
  // self-references the parameter rather than the @napi-rs/canvas module — an
  // upstream typing bug, so the resolver has to be cast through.
  const canvasFactory = await createIsomorphicCanvasFactory(
    canvasResolver as unknown as Parameters<typeof createIsomorphicCanvasFactory>[0],
  );
  const doc = await getDocumentProxy(new Uint8Array(bytes), {
    // pdfjs option name; unpdf passes it straight through to getDocument.
    canvasFactory,
  } as Parameters<typeof getDocumentProxy>[1]);

  const pageCount = Math.min(doc.numPages, OCR_MAX_PAGES);
  const pages: string[] = [];

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    const png = await renderPageAsImage(doc, pageNumber, {
      scale: 2,
      canvas: canvasResolver as unknown as Parameters<typeof createIsomorphicCanvasFactory>[0],
    });
    const dataUrl = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
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
