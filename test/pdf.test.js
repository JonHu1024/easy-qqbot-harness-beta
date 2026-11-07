import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { extractPdfText } from '../src/pdf.js';

// --- minimal PDF builder (no dependencies; xref included for realism) --------
function buildPdf(objects, { encrypt = false } = {}) {
  const parts = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = parts[0].length;
  const offsets = [];
  objects.forEach((body, k) => {
    const b = Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1');
    const head = Buffer.from(`${k + 1} 0 obj\n`, 'latin1');
    const tail = Buffer.from('\nendobj\n', 'latin1');
    offsets.push(offset);
    parts.push(head, b, tail);
    offset += head.length + b.length + tail.length;
  });
  const xrefStart = offset;
  let tail = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) tail += `${String(o).padStart(10, '0')} 00000 n \n`;
  tail += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encrypt ? ' /Encrypt 90 0 R' : ''} >>\n`;
  tail += `startxref\n${xrefStart}\n%%EOF\n`;
  parts.push(Buffer.from(tail, 'latin1'));
  return Buffer.concat(parts);
}

const flate = data => zlib.deflateSync(Buffer.from(data, 'latin1'));
const streamBody = (extra, data) => Buffer.concat([
  Buffer.from(`<< /Length ${data.length}${extra} >>\nstream\n`, 'latin1'),
  data,
  Buffer.from('\nendstream', 'latin1'),
]);

// --- 1. FlateDecode + uncompressed, escapes/octal + UTF-16BE BOM ------------
test('extracts FlateDecode and uncompressed text, handling escapes, octal and UTF-16BE BOM', async () => {
  const content1 = 'BT /F1 24 Tf 72 700 Td (Hello \\(World\\)) Tj T* (Octal: \\101\\102\\103) Tj ET';
  const content2 = 'BT /F1 12 Tf 72 700 Td <FEFF00480065006C006C006F> Tj ET';
  const pdf = buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    streamBody(' /Filter /FlateDecode', flate(content1)),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    streamBody('', Buffer.from(content2, 'latin1')),
  ]);
  const res = await extractPdfText(pdf);
  assert.equal(res.ok, true);
  assert.match(res.text, /Hello \(World\)/);
  assert.match(res.text, /Octal: ABC/);
  assert.match(res.text, /Hello/);
  assert.equal(res.pages, 2);
  assert.ok(Array.isArray(res.notes));
  await assert.doesNotReject(() => extractPdfText(pdf, {}));
});

// --- 2. CID font + ToUnicode CMap (bfchar + bfrange), unmapped CID skipped --
test('maps CID codes through ToUnicode (bfchar/bfrange) and skips unmapped CIDs', async () => {
  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    '2 beginbfchar',
    '<0001> <00480065>',
    '<0002> <006C006C006F>',
    'endbfchar',
    '1 beginbfrange',
    '<0010> <0012> <0030>',
    'endbfrange',
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
  const content = 'BT /F1 12 Tf 72 700 Td <00010002> Tj T* <001000110012> Tj T* <0099> Tj ET';
  const pdf = buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    streamBody(' /Filter /FlateDecode', flate(content)),
    '<< /Type /Font /Subtype /Type0 /BaseFont /Test /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>',
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Test /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>',
    streamBody(' /Filter /FlateDecode', flate(cmap)),
  ]);
  const res = await extractPdfText(pdf);
  assert.equal(res.ok, true);
  assert.match(res.text, /Hello/);
  assert.match(res.text, /012/);
  assert.ok(!res.text.includes('\uFFFD'));
  assert.ok(!/[\uE000-\uF8FF]/.test(res.text));
  assert.ok(res.notes.some(n => /未在 ToUnicode 中映射/.test(n)));
});

// --- 2b. Type0 without ToUnicode => no garbage, ok=false --------------------
test('Type0 font without ToUnicode emits no garbage text', async () => {
  const content = 'BT /F1 12 Tf 72 700 Td <00010002> Tj ET';
  const pdf = buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    streamBody(' /Filter /FlateDecode', flate(content)),
    '<< /Type /Font /Subtype /Type0 /BaseFont /Test /Encoding /Identity-H /DescendantFonts [6 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Test >>',
  ]);
  const res = await extractPdfText(pdf);
  assert.equal(res.ok, false);
  assert.equal(res.text, '');
  assert.ok(res.notes.some(n => /ToUnicode/.test(n)));
});

// --- 3. scanned / image-only PDF => ok=false, no fabrication ----------------
test('scanned PDF with no text operators returns ok=false', async () => {
  const pdf = buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    streamBody(' /Filter /FlateDecode', flate('q 612 0 0 792 0 0 cm Q')),
  ]);
  const res = await extractPdfText(pdf);
  assert.equal(res.ok, false);
  assert.equal(res.text, '');
  assert.ok(res.notes.length > 0);
  assert.ok(res.notes.some(n => /未提取到可用文本/.test(n)));
});

// --- 4. encrypted PDF => ok=false with reason -------------------------------
test('encrypted PDF is reported as unextractable', async () => {
  const pdf = buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    streamBody(' /Filter /FlateDecode', flate('BT /F1 12 Tf 72 700 Td (secret) Tj ET')),
  ], { encrypt: true });
  const res = await extractPdfText(pdf);
  assert.equal(res.ok, false);
  assert.equal(res.text, '');
  assert.ok(res.notes.some(n => /加密/.test(n)));
});

// --- 5. maxChars truncation ------------------------------------------------
test('maxChars truncates and records a note', async () => {
  const content = 'BT /F1 12 Tf 72 700 Td (ABCDEFGHIJKLMNOPQRSTUVWXYZ) Tj ET';
  const pdf = buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    streamBody(' /Filter /FlateDecode', flate(content)),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]);
  const res = await extractPdfText(pdf, { maxChars: 10 });
  assert.equal(res.ok, true);
  assert.ok(res.text.length <= 10);
  assert.ok(res.notes.some(n => /截断/.test(n)));
});

// --- 6. signal cancellation ------------------------------------------------
test('aborted signal rejects with AbortError', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => extractPdfText(Buffer.from('%PDF-1.7\n', 'latin1'), { signal: controller.signal }),
    err => err.name === 'AbortError',
  );
});

// --- 6b. compressed object streams (ObjStm) --------------------------------
test('resolves objects stored inside a compressed object stream', async () => {
  const content = 'BT /F1 12 Tf 72 700 Td (FromObjStm) Tj ET';
  const fontBody = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  const objStmData = flate(`6 0 ${fontBody}`);
  const pdf = buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents 4 0 R >>',
    streamBody(' /Filter /FlateDecode', flate(content)),
    streamBody(' /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode', objStmData),
  ]);
  const res = await extractPdfText(pdf);
  assert.equal(res.ok, true);
  assert.match(res.text, /FromObjStm/);
});

// --- 7. non-PDF and empty inputs -------------------------------------------
test('non-PDF and empty inputs fail with a reason instead of empty success', async () => {
  const notPdf = await extractPdfText(Buffer.from('hello world'));
  assert.equal(notPdf.ok, false);
  assert.ok(notPdf.notes.some(n => /不是有效的 PDF/.test(n)));

  const empty = await extractPdfText(Buffer.alloc(0));
  assert.equal(empty.ok, false);
  assert.ok(empty.notes.some(n => /输入为空/.test(n)));
});
