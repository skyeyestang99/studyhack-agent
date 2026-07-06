import { extractText, getDocumentProxy } from "unpdf";
import { parseOfficeAsync } from "officeparser";
import { ocrPdf } from "./ocr.js";

export interface Extracted {
  text: string;
  pages: number;
  pageTexts?: string[]; // per-page text (PDF) so chunks can record their page number
}

/**
 * Extract plain text from a file by content type: PDF (with OCR fallback for
 * scanned/image PDFs), Office (docx/pptx), and plain text.
 */
export async function extract(
  bytes: Buffer,
  contentType: string,
  fileName: string,
): Promise<Extracted> {
  const name = fileName.toLowerCase();
  const isPdf = contentType.includes("pdf") || name.endsWith(".pdf");

  if (isPdf) {
    const pdfDoc = await getDocumentProxy(new Uint8Array(bytes));
    // mergePages:false → per-page array, so chunks can carry their page number.
    const { text, totalPages } = await extractText(pdfDoc, { mergePages: false });
    const pageTexts = Array.isArray(text) ? text : [text];
    const merged = pageTexts.join("\n");
    // A scanned/photographed PDF has little or no text layer — OCR it (vision).
    if (merged.trim().length >= Math.max(40, totalPages * 20)) {
      return { text: merged, pages: totalPages, pageTexts };
    }
    const ocrText = await ocrPdf(bytes);
    return { text: ocrText || merged, pages: totalPages, pageTexts: [ocrText || merged] };
  }

  const isOffice =
    /\.(docx|pptx|xlsx)$/.test(name) || /officedocument/.test(contentType);
  if (isOffice) {
    const text = (await parseOfficeAsync(bytes)) ?? "";
    return { text, pages: 1, pageTexts: [text] };
  }

  if (/text|csv|markdown|json/.test(contentType) || /\.(txt|csv|md|json)$/.test(name)) {
    const text = bytes.toString("utf8");
    return { text, pages: 1, pageTexts: [text] };
  }

  throw new Error(`Unsupported content type for extraction: ${contentType} (${fileName})`);
}
