import { extractText, getDocumentProxy, resolvePDFJSImports } from "unpdf";
import { parseOfficeAsync } from "officeparser";
import { ocrPdf } from "./ocr.js";

/**
 * Force unpdf to use its OWN bundled pdfjs build.
 *
 * Without this, unpdf auto-detects the `pdfjs-dist` that `pdf-to-img` (used by
 * the OCR fallback) hoists into node_modules root, and pairs that API with
 * unpdf's bundled worker. When the two versions drift, every PDF extraction
 * fails with:
 *   The API version "4.2.67" does not match the Worker version "4.3.136".
 *
 * This silently broke ALL PDF ingestion (2026-08) after a floating `^unpdf`
 * bump changed the bundled pdfjs version. Pinning either package is fragile
 * because both float independently; resolving explicitly is version-proof.
 */
let pdfjsReady: Promise<void> | undefined;
function ensurePdfjs(): Promise<void> {
  pdfjsReady ??= resolvePDFJSImports(() => import("unpdf/pdfjs"), { force: true });
  return pdfjsReady;
}

export interface Extracted {
  text: string;
  pages: number;
  pageTexts?: string[]; // per-page text (PDF) so chunks can record their page number
}

/**
 * Strip characters Postgres `text` columns reject and that carry no meaning for
 * retrieval. NUL (0x00) is the important one: real PDFs contain it in their text
 * layer, and inserting it fails the whole ingest with
 *   invalid byte sequence for encoding "UTF8": 0x00
 * Observed on real course PDFs (2026-08-09). Also drops lone surrogates, which
 * break both Postgres and the embeddings API.
 */
function sanitizeText(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\u0000/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
    .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "$1");
}

/**
 * Per-material-type OCR page budgets. EXAM and HOMEWORK are the highest-value
 * documents in a course — they're what "what does this professor actually test"
 * is built from — and they're also the most likely to be scanned. A 15-page cap
 * silently truncated them (2 real exam PDFs yielded only 10 chunks total), so
 * they get a much larger budget. Bulk lecture scans stay capped because they're
 * long, numerous, and individually less load-bearing.
 */
const OCR_MAX_PAGES_BY_TYPE: Record<string, number> = {
  EXAM: Number(process.env.OCR_MAX_PAGES_EXAM ?? 60),
  HOMEWORK: Number(process.env.OCR_MAX_PAGES_HOMEWORK ?? 40),
  SYLLABUS: Number(process.env.OCR_MAX_PAGES_SYLLABUS ?? 20),
};

export interface ExtractOptions {
  /** materials.material_type — drives the OCR page budget. */
  materialType?: string | null;
}

/**
 * Extract plain text from a file by content type: PDF (with OCR fallback for
 * scanned/image PDFs), Office (docx/pptx), and plain text.
 */
export async function extract(
  bytes: Buffer,
  contentType: string,
  fileName: string,
  options: ExtractOptions = {},
): Promise<Extracted> {
  const name = fileName.toLowerCase();
  const isPdf = contentType.includes("pdf") || name.endsWith(".pdf");

  if (isPdf) {
    await ensurePdfjs();
    const pdfDoc = await getDocumentProxy(new Uint8Array(bytes));
    // mergePages:false → per-page array, so chunks can carry their page number.
    const { text, totalPages } = await extractText(pdfDoc, { mergePages: false });
    const pageTexts = (Array.isArray(text) ? text : [text]).map(sanitizeText);
    const merged = pageTexts.join("\n");
    // A scanned/photographed PDF has little or no text layer — OCR it (vision).
    if (merged.trim().length >= Math.max(40, totalPages * 20)) {
      return { text: merged, pages: totalPages, pageTexts };
    }
    const maxPages = options.materialType
      ? OCR_MAX_PAGES_BY_TYPE[options.materialType]
      : undefined;
    // Keep OCR output per-page so chunks retain real page numbers (citations
    // offer page-jump; a merged blob made every chunk cite page 1).
    const ocrPages = (await ocrPdf(bytes, { maxPages })).map(sanitizeText);
    const ocrMerged = ocrPages.join("\n").trim();
    if (!ocrMerged) {
      return { text: merged, pages: totalPages, pageTexts };
    }
    return { text: ocrMerged, pages: totalPages, pageTexts: ocrPages };
  }

  const isOffice =
    /\.(docx|pptx|xlsx)$/.test(name) || /officedocument/.test(contentType);
  if (isOffice) {
    const text = sanitizeText((await parseOfficeAsync(bytes)) ?? "");
    return { text, pages: 1, pageTexts: [text] };
  }

  if (/text|csv|markdown|json/.test(contentType) || /\.(txt|csv|md|json)$/.test(name)) {
    const text = sanitizeText(bytes.toString("utf8"));
    return { text, pages: 1, pageTexts: [text] };
  }

  throw new Error(`Unsupported content type for extraction: ${contentType} (${fileName})`);
}
