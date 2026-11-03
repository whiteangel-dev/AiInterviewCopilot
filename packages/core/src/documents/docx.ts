import { strFromU8, unzipSync } from 'fflate';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const TOKEN = /<(\/?)([a-zA-Z0-9:]+)([^>]*?)(\/?)>|([^<]+)/g;

/**
 * Plain text from WordprocessingML: paragraphs become lines, list items get a
 * bullet, table cells are separated by tabs and rows by line breaks.
 */
export function wordXmlToText(xml: string): string {
  // Text boxes are stored twice (DrawingML + a VML fallback); keep one copy.
  const source = xml.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '');
  const lines: string[] = [];
  let para = '';
  let isListItem = false;
  let inText = false;
  let cellDepth = 0;
  let row: string[] = [];
  let cell = '';

  const endParagraph = () => {
    const text = (isListItem ? '• ' : '') + para.replace(/[ \u00a0]+$/g, '');
    if (cellDepth > 0) cell += (cell && text ? ' ' : '') + text;
    else lines.push(text);
    para = '';
    isListItem = false;
  };

  for (const m of source.matchAll(TOKEN)) {
    const [, closing, name, attrs = '', selfClosing, text] = m;
    if (text !== undefined) {
      if (inText) para += decodeEntities(text);
      continue;
    }
    switch (name) {
      case 'w:t':
        inText = !closing && !selfClosing;
        break;
      case 'w:tab':
        if (!closing) para += '\t';
        break;
      case 'w:br':
      case 'w:cr':
        if (!closing) para += '\n';
        break;
      case 'w:noBreakHyphen':
        para += '-';
        break;
      case 'w:numPr':
        if (!closing) isListItem = true;
        break;
      case 'w:pStyle':
        if (/w:val="List/i.test(attrs)) isListItem = true;
        break;
      case 'w:p':
        if (selfClosing) endParagraph();
        else if (closing) endParagraph();
        else {
          para = '';
          isListItem = false;
        }
        break;
      case 'w:tc':
        if (closing) {
          row.push(cell.trim());
          cell = '';
          cellDepth--;
        } else if (!selfClosing) cellDepth++;
        break;
      case 'w:tr':
        if (closing) {
          lines.push(row.filter(Boolean).join('\t'));
          row = [];
        }
        break;
    }
  }
  return lines.join('\n');
}

/** Body text of a .docx, with headers first (resumes often put contact details there). */
export function extractDocxText(bytes: Uint8Array): string {
  const files = unzipSync(bytes, {
    filter: (f) => f.name === 'word/document.xml' || /^word\/header\d*\.xml$/.test(f.name),
  });
  const body = files['word/document.xml'];
  if (!body) throw new Error('word/document.xml is missing');
  const headers = Object.keys(files)
    .filter((n) => n.startsWith('word/header'))
    .sort()
    .map((n) => wordXmlToText(strFromU8(files[n]!)))
    .filter((t) => t.trim());
  return [...new Set(headers), wordXmlToText(strFromU8(body))].join('\n');
}
