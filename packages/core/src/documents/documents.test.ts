import { readFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { extractDocument } from './extract';
import { wordXmlToText } from './docx';
import { buildQuoteIndex, isQuoteInDocument, tokenize } from './quotes';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../fixtures/${name}`, import.meta.url)));

describe('extractDocument', () => {
  it('reads a PDF with a text layer', async () => {
    const doc = await extractDocument(fixture('resume-jordan-rivera.pdf'), 'resume.pdf');
    expect(doc).toMatchObject({ kind: 'pdf', mimeType: 'application/pdf', textQuality: 'good' });
    expect(doc.pageCount).toBeGreaterThanOrEqual(1);
    expect(doc.text).toContain('Jordan Rivera');
    expect(doc.text).toContain('99.95% availability');
  });

  it('reads a .docx, including list bullets and tables', async () => {
    const doc = await extractDocument(fixture('resume-jordan-rivera.docx'), 'resume.docx');
    expect(doc).toMatchObject({ kind: 'docx', textQuality: 'good', pageCount: null });
    expect(doc.text).toContain('• Led the redesign of the shipment-event pipeline');
    expect(doc.text).toContain(
      'Quayside Logistics — Senior Software Engineer, Platform\tMar 2021 – Present',
    );
    expect(doc.text).toContain('Languages\tTypeScript, Go, SQL');
  });

  it('flags a scanned PDF (no text layer)', async () => {
    const doc = await extractDocument(fixture('resume-scanned.pdf'), 'scan.pdf');
    expect(doc.textQuality).toBe('none');
  });

  it('rejects other formats with a clear message', async () => {
    await expect(extractDocument(strToU8('hello'), 'notes.txt')).rejects.toMatchObject({
      code: 'unsupported_file',
    });
    await expect(
      extractDocument(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2]), 'old.doc'),
    ).rejects.toThrow(/old Word/);
    await expect(
      extractDocument(zipSync({ 'a.txt': strToU8('x') }), 'fake.docx'),
    ).rejects.toMatchObject({
      code: 'unsupported_file',
    });
    await expect(extractDocument(new Uint8Array(0), 'empty.pdf')).rejects.toMatchObject({
      code: 'unsupported_file',
    });
  });
});

describe('wordXmlToText', () => {
  it('decodes entities, keeps tabs and breaks, and skips VML fallbacks', () => {
    const xml =
      '<w:p><w:r><w:t>R&amp;D &#8212; A&lt;B</w:t><w:tab/><w:t>2020</w:t><w:br/><w:t>next</w:t></w:r></w:p>' +
      '<mc:AlternateContent><mc:Choice><w:p><w:r><w:t>box</w:t></w:r></w:p></mc:Choice><mc:Fallback><w:p><w:r><w:t>box</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent>';
    expect(wordXmlToText(xml)).toBe('R&D — A<B\t2020\nnext\nbox');
  });
});

describe('quotes', () => {
  const index = buildQuoteIndex(
    'Led the redesign of the shipment-event pipeline from a cron-based batch system to Kafka streaming on AWS\nMSK; cut tracking-update latency from about 15 minutes to under 5 seconds. Effi­cient ﬁle handling.',
  );

  it('tokenizes across ligatures, soft hyphens, and line breaks', () => {
    expect(tokenize('Eﬃcient — “quoted”')).toEqual(['efficient', 'quoted']);
  });

  it.each([
    'cut tracking-update latency from about 15 minutes to under 5 seconds',
    'Kafka streaming on AWS MSK',
    'Led the redesign of the shipment event pipeline from a cron based batch system',
    'Efficient file handling',
    'the redesign of the shipment-event pipeline from a batch system to Kafka streaming on AWS MSK', // one word dropped
  ])('finds "%s"', (q) => expect(isQuoteInDocument(q, index)).toBe(true));

  it.each([
    'cut tracking-update latency from about 30 minutes to under 5 seconds',
    'Won the company-wide engineering excellence award',
    '',
  ])('rejects "%s"', (q) => expect(isQuoteInDocument(q, index)).toBe(false));
});
