import { extractText, getDocumentProxy } from "unpdf";
import { parseOfficeAsync } from "officeparser";
import { ocrPdf } from "./ocr.js";

export interface Extracted {
  text: string;
  pages: number;
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
    const { text, totalPages } = await extractText(pdfDoc, { mergePages: true });
    const merged = Array.isArray(text) ? text.join("\n") : text;
    // A scanned/photographed PDF has little or no text layer — OCR it (vision).
    if (merged.trim().length >= Math.max(40, totalPages * 20)) {
      return { text: merged, pages: totalPages };
    }
    const ocrText = await ocrPdf(bytes);
    return { text: ocrText || merged, pages: totalPages };
  }

  const isOffice =
    /\.(docx|pptx|xlsx)$/.test(name) || /officedocument/.test(contentType);
  if (isOffice) {
    const text = await parseOfficeAsync(bytes);
    return { text: text ?? "", pages: 1 };
  }

  if (/text|csv|markdown|json/.test(contentType) || /\.(txt|csv|md|json)$/.test(name)) {
    return { text: bytes.toString("utf8"), pages: 1 };
  }

  throw new Error(`Unsupported content type for extraction: ${contentType} (${fileName})`);
}
