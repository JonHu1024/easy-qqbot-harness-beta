import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadMedia, isPublicAddress, normalizeAttachments, prepareInput, validateAttachments } from '../src/media.js';

const config = { harness: { maxAttachmentMB: 1, maxImages: 2, visionEnabled: true, filesEnabled: true } };
const data = (type, bytes) => `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

test('public IP boundary rejects private/reserved/transition addresses', () => {
  for (const address of ['0.0.0.0', '10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.0.1', '100.64.0.1', '100.127.255.255', '192.0.0.1', '192.0.2.1', '192.88.99.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:8.8.8.8', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2001::1', '2002:0808:0808::1', '3fff::1', 'not-an-ip']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '100.63.255.255', '100.128.0.1', '172.15.255.255', '172.32.0.1', '2001:4860:4860::8888', '2606:4700:4700::1111']) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test('preview validation permits real QQ/gtimg/qpic/public HTTPS but no credential or local URL', () => {
  for (const url of ['https://multimedia.nt.qq.com.cn/download?rkey=ephemeral', 'https://miniapp.gtimg.cn/a.png', 'https://pubminishare-30161.picsz.qpic.cn/a.png', 'https://example.com/image.png', gif]) {
    assert.equal(validateAttachments([{ url, filename: 'x.gif', contentType: 'image/gif' }], config)[0].url, url);
  }
  for (const url of ['http://example.com/a', 'file:///etc/passwd', 'https://u:p@example.com/a', 'https://127.0.0.1/a', 'https://[::1]/a', 'https://example.com:8443/a', 'data:text/html;base64,PGgxPng8L2gxPg==']) {
    assert.throws(() => validateAttachments([{ url }], config), undefined, url);
  }
  assert.throws(() => validateAttachments([{ url: gif }, { url: gif }, { url: gif }], config), /图片数量/);
});

test('actual image bytes enter image_url; summary and normalized metadata omit base64', async () => {
  const result = await prepareInput({ content: '', attachments: [{ url: gif, filename: 'pixel.gif', contentType: 'image/gif', auth_token: 'secret' }] }, config);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.parts.find(p => p.type === 'image_url').image_url.url, gif);
  assert.match(result.summary, /pixel.gif/);
  assert.doesNotMatch(result.summary, /base64|secret/);
  const normalized = normalizeAttachments([{ url: gif, filename: 'pixel.gif', content_type: 'image/gif', auth_token: 'secret' }]);
  assert.equal(normalized[0].url, '');
  assert.equal('auth_token' in normalized[0], false);
  const implicit = await prepareInput({ attachments: [{ url: gif }] }, config);
  assert.ok(implicit.parts.some(p => p.type === 'image_url'));
});

test('UTF8 text and PDF files contain real bytes rather than source URL', async () => {
  const textURL = data('text/markdown', '# title\nactual file body');
  const pdfURL = data('application/pdf', '%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
  const pdfConfig = { ...config, harness: { ...config.harness, pdfFileParts: true } };
  const result = await prepareInput({ content: 'read these', attachments: [
    { url: textURL, filename: 'notes.md', contentType: 'text/markdown' },
    { url: pdfURL, filename: 'notes.pdf', contentType: 'application/pdf' },
  ] }, pdfConfig);
  assert.equal(result.warnings.length, 0);
  assert.ok(result.parts.some(p => p.type === 'text' && p.text.includes('actual file body')));
  assert.deepEqual(result.parts.find(p => p.type === 'file'), { type: 'file', file: { filename: 'notes.pdf', file_data: pdfURL } });
  assert.doesNotMatch(result.summary, /actual file body|base64/);
});

test('corrupt/truncated image, invalid UTF8 and invalid PDF explicitly report unread content', async () => {
  const attachments = [
    { url: data('image/png', 'not a png'), filename: 'bad.png', contentType: 'image/png' },
    { url: data('text/plain', Buffer.from([0xc3, 0x28])), filename: 'bad.txt', contentType: 'text/plain' },
    { url: data('application/pdf', '%PDF-1.7\ntruncated'), filename: 'bad.pdf', contentType: 'application/pdf' },
  ];
  const result = await prepareInput({ attachments }, config);
  assert.equal(result.warnings.length, 3);
  assert.equal(result.parts.some(p => p.type === 'file' || p.type === 'image_url'), false);
  assert.match(result.summary, /未读取/);
});

test('unsupported audio/video keeps only metadata and labeled QQ ASR', async () => {
  const result = await prepareInput({ attachments: [{ url: 'https://127.0.0.1/never-download', filename: 'voice.silk', contentType: 'voice', asrText: 'QQ transcript' }] }, config);
  assert.equal(result.warnings.length, 1);
  assert.match(result.parts.map(p => p.text || '').join('\n'), /QQ ASR 参考转写，未经核实.*\nQQ transcript/);
  assert.doesNotMatch(JSON.stringify(result), /127\.0\.0\.1/);
});

test('download bounds canonical Base64 and cancellation', async () => {
  await assert.rejects(downloadMedia(data('text/plain', '12345'), { maxBytes: 4 }), /大小限制/);
  await assert.rejects(downloadMedia('data:text/plain;base64,YR=='), /Base64/);
  await assert.rejects(downloadMedia('https://169.254.169.254/metadata'), /公共网络/);
  const controller = new AbortController(); controller.abort(new Error('stop'));
  await assert.rejects(prepareInput({ attachments: [] }, config, { signal: controller.signal }), /stop/);
});

test('quoted content and unavailable reference stay distinct from user instructions', async () => {
  const result = await prepareInput({ content: 'my question', reference: { source: 'event', authorId: 'u', content: 'quoted background', attachments: [{ url: gif, filename: 'quote.gif', contentType: 'image/gif' }] } }, config);
  assert.equal(result.parts[0].text, 'my question');
  assert.match(result.summary, /仅作为背景资料/);
  assert.match(result.summary, /quoted background/);
  assert.ok(result.parts.some(p => p.type === 'image_url'));
  const missing = await prepareInput({ content: 'what was that?', reference: { source: 'unavailable', content: 'must not use stale quote' } }, config);
  assert.match(missing.summary, /内容不可用/);
  assert.doesNotMatch(JSON.stringify(missing), /must not use stale/);
});
