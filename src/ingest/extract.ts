import { extractText, getDocumentProxy } from "unpdf";

export interface Extracted {
  text: string;
  pages: number;
}

/**
 * Extract plain text from a file by content type. Minimal slice: PDF + text.
 * (Upgrade path: LlamaParse for clean Markdown; python-pptx/mammoth for PPTX/DOCX;
 * OCR for scanned PDFs.)
 */
export async function extract(
  bytes: Buffer,
  contentType: string,
  fileName: string,
): Promise<Extracted> {
  const name = fileName.toLowerCase();
  const isPdf = contentType.includes("pdf") || name.endsWith(".pdf");

  if (isPdf) {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text, totalPages } = await extractText(pdf, { mergePages: true });
    return { text: Array.isArray(text) ? text.join("\n") : text, pages: totalPages };
  }

  if (/text|csv|markdown|json/.test(contentType) || /\.(txt|csv|md|json)$/.test(name)) {
    return { text: bytes.toString("utf8"), pages: 1 };
  }

  throw new Error(`Unsupported content type for extraction: ${contentType} (${fileName})`);
}
