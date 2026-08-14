import {
  createIsomorphicCanvasFactory,
  getDocumentProxy,
  renderPageAsImage,
} from "unpdf";
import OpenAI from "openai";
import { config } from "../config.js";
import { OCR_PROMPT } from "../prompts.js";

const client = new OpenAI({ apiKey: config.openaiApiKey });

// Default page budget. Kept low for bulk material (a lecture scan can be huge
// and OCR costs one vision call per page), but callers override it — see
// OCR_MAX_PAGES_BY_TYPE in extract.ts. Exams and homework get a much larger
// budget: they're the highest-value documents in the corpus, and silently
// truncating them loses exactly what students came for.
const OCR_MAX_PAGES = Number(process.env.OCR_MAX_PAGES ?? 15);


// @napi-rs/canvas ships prebuilt binaries (no system deps). unpdf renders into it.
/**
 * Cast is deliberate and lives here rather than at each call site. unpdf types
 * this resolver against the `canvas` (node-canvas) package, but we supply
 * `@napi-rs/canvas` — API-compatible for createCanvas, different module type.
 * The resolved type is also environment-dependent: when `canvas` is absent the
 * annotation collapses to a self-referential shape, so identical code
 * typechecked locally and failed in CI where `canvas` types were present.
 */
const canvasResolver = (() => import("@napi-rs/canvas")) as unknown as never;

/**
 * OCR a scanned/image PDF: rasterize each page to a PNG and transcribe it with
 * a vision model. Used as the fallback when a PDF has no extractable text layer.
 *
 * Rasterization goes through unpdf rather than `pdf-to-img` on purpose:
 * `pdf-to-img` bundles its own `pdfjs-dist`, and two pdfjs versions in one
 * process break BOTH paths (pdfjs registers a process-global worker).
 *
 * Returns text PER PAGE rather than one merged blob. Chunks record the page they
 * came from and citations offer page-jump, so merging made every chunk from a
 * scanned document cite page 1 — destroying provenance on exams and homework,
 * which are the documents most likely to be scanned.
 *
 * The canvas factory must be attached to the DOCUMENT, not just passed to
 * renderPageAsImage. unpdf only wires its factory in when it constructs the
 * document itself:
 *   const pdf = isPDFDocumentProxy(data) ? data : await getDocumentProxy(data, { canvasFactory })
 * so handing it a proxy we built ourselves leaves pdfjs's default, canvas-less
 * factory in place and every render fails with
 * `Cannot read properties of undefined (reading 'createCanvas')`.
 */
export async function ocrPdf(
  bytes: Buffer,
  options: { maxPages?: number } = {},
): Promise<string[]> {
  // unpdf types this param as `() => Promise<typeof canvas>`, where `canvas`
  // self-references the parameter rather than the @napi-rs/canvas module — an
  // upstream typing bug, so the resolver has to be cast through.
  const canvasFactory = await createIsomorphicCanvasFactory(
    canvasResolver,
  );
  const doc = await getDocumentProxy(new Uint8Array(bytes), {
    // pdfjs option name; unpdf passes it straight through to getDocument.
    canvasFactory,
  } as Parameters<typeof getDocumentProxy>[1]);

  const budget = options.maxPages ?? OCR_MAX_PAGES;
  const pageCount = Math.min(doc.numPages, budget);
  const pages: string[] = [];

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    const png = await renderPageAsImage(doc, pageNumber, {
      scale: 2,
      canvas: canvasResolver,
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
    // Keep the slot even if a page transcribes empty, so index i === page i+1.
    pages.push(res.choices[0]?.message?.content?.trim() ?? "");
  }

  if (doc.numPages > pageCount) {
    console.warn(
      `ocr truncated: ${pageCount}/${doc.numPages} pages transcribed (budget ${budget})`,
    );
  }

  return pages;
}
