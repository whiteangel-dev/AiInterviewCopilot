import { AppError } from '@aic/ipc';
import { extractText } from 'unpdf';
import { extractDocxText } from './docx';

export type DocumentKind = 'pdf' | 'docx';

/** `none`: no usable text layer (e.g. a scanned PDF); `low`: very little text. */
export type TextQuality = 'good' | 'low' | 'none';

export interface ExtractedDocument {
  kind: DocumentKind;
  mimeType: string;
  text: string;
  pageCount: number | null;
  textQuality: TextQuality;
}

export const MAX_RESUME_BYTES = 10 * 1024 * 1024;

export const MIME_TYPES: Record<DocumentKind, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const startsWith = (bytes: Uint8Array, sig: number[]) => sig.every((b, i) => bytes[i] === b);

/** Detects the format from the file's bytes; the extension is only used for messages. */
export function detectDocumentKind(bytes: Uint8Array, fileName: string): DocumentKind {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'; // %PDF-
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'docx'; // ZIP; checked when opened
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) {
    throw new AppError(
      'unsupported_file',
      `"${fileName}" is an old Word (.doc) file. Save it as .docx or PDF in Word, then import that.`,
    );
  }
  throw new AppError('unsupported_file', `"${fileName}" isn't a PDF or Word (.docx) file.`);
}

/** Collapses runs of spaces and blank lines, keeping the line structure. */
export function tidyText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+\n/g, '\n')
    .replace(/[ \u00a0]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function quality(text: string, pages: number): TextQuality {
  const letters = text.replace(/[^\p{L}\p{N}]/gu, '').length;
  if (letters < 40) return 'none';
  return letters / Math.max(pages, 1) < 300 ? 'low' : 'good';
}

/** Extracts text locally. Nothing leaves the device here. */
export async function extractDocument(
  bytes: Uint8Array,
  fileName: string,
): Promise<ExtractedDocument> {
  if (bytes.byteLength === 0) throw new AppError('unsupported_file', `"${fileName}" is empty.`);
  if (bytes.byteLength > MAX_RESUME_BYTES) {
    throw new AppError('file_too_large', `"${fileName}" is larger than 10 MB.`);
  }
  const kind = detectDocumentKind(bytes, fileName);
  try {
    if (kind === 'pdf') {
      // pdf.js detaches the buffer it is given, so pass a copy.
      const { totalPages, text } = await extractText(bytes.slice(), { mergePages: true });
      const tidy = tidyText(text);
      return {
        kind,
        mimeType: MIME_TYPES.pdf,
        text: tidy,
        pageCount: totalPages,
        textQuality: quality(tidy, totalPages),
      };
    }
    const tidy = tidyText(extractDocxText(bytes));
    return {
      kind,
      mimeType: MIME_TYPES.docx,
      text: tidy,
      pageCount: null,
      textQuality: quality(tidy, 1),
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(
      'unsupported_file',
      kind === 'pdf'
        ? `"${fileName}" couldn't be read. It may be damaged or password-protected.`
        : `"${fileName}" isn't a readable Word document.`,
      { cause: err },
    );
  }
}
