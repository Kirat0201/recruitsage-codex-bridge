import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openStore } from '../src/store.mjs';
import { extractDocument } from '../src/parse.mjs';
import { getDocumentExcerpt } from '../src/document-excerpt.mjs';

const jobId = '11111111-1111-4111-8111-111111111111';
const documentId = '22222222-2222-4222-8222-222222222222';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rs-excerpt-'));
  const root = path.join(dir, 'documents');
  mkdirSync(root, { mode: 0o700 });
  const db = openStore(path.join(dir, 'jobs.sqlite'));
  return { dir, root, db, done() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function saveDocument(x, binary, text, { name = 'sample.pdf', extraction = null } = {}) {
  const sha256 = hash(binary);
  const folder = path.join(x.root, jobId); mkdirSync(folder, { mode: 0o700 });
  const localPath = path.join(folder, `${sha256}.bin`);
  const textPath = path.join(folder, `${sha256}.txt`);
  writeFileSync(localPath, binary, { mode: 0o600 });
  writeFileSync(textPath, text, { mode: 0o600 });
  x.db.prepare('INSERT INTO documents(id,job_id,payload,sha256,local_path,text_path,downloaded_at) VALUES(?,?,?,?,?,?,?)')
    .run(documentId, jobId, JSON.stringify({ original_name: name, mime_type: name.endsWith('.pdf') ? 'application/pdf' : 'text/plain', ...(extraction ? { extraction } : {}) }), sha256, localPath, textPath, '2026-01-01T00:00:00.000Z');
  return { sha256, localPath, textPath };
}
function pdfFixture() {
  const one = 'BT /F1 12 Tf 72 720 Td (Alpha engineering role and API design.) Tj ET';
  const two = 'BT /F1 12 Tf 72 720 Td (Beta interview topic and debugging.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${one.length} >>\nstream\n${one}\nendstream`,
    `<< /Length ${two.length} >>\nstream\n${two}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test('PDF keyword excerpt backfills page numbers from cached binary without network', async () => {
  const x = fixture();
  try {
    const binary = pdfFixture();
    const parsed = await extractDocument(binary, 'sample.pdf', 'application/pdf');
    assert.equal(parsed.pages.length, 2);
    const { sha256 } = saveDocument(x, binary, parsed.text);
    const result = await getDocumentExcerpt(x.db, { sha256, keyword: 'Beta', limit: 100 }, { root: x.root });
    assert.equal(result.source, 'local extracted document cache');
    assert.equal(result.networkRequests, 0);
    assert.equal(result.sha256, sha256);
    assert.equal(result.jobId, jobId);
    assert.equal(result.filename, 'sample.pdf');
    assert.equal(result.excerpts[0].pageNumber, 2);
    assert.ok(result.excerpts[0].text.includes('Beta'));
    assert.ok(result.excerpts[0].end > result.excerpts[0].start);
    assert.ok(result.extractedAt);
    assert.equal(result.extractionProvenance, 'local reparse of cached binary');
    const again = await getDocumentExcerpt(x.db, { documentId, offset: 0, limit: 100 }, { root: x.root });
    assert.equal(again.excerpts[0].pageNumber, 1);
    assert.equal(again.extractedAt, result.extractedAt);
  } finally { x.done(); }
});

test('keyword pagination and character paging have strict output bounds', async () => {
  const x = fixture();
  try {
    const text = 'alpha placement evidence. '.repeat(200);
    const binary = Buffer.from(text);
    const { sha256 } = saveDocument(x, binary, text, { name: 'notes.txt', extraction: {
      format: 'txt', status: 'extracted', extractedAt: '2026-01-01T00:00:00.000Z', textSha256: hash(Buffer.from(text)),
    } });
    const first = await getDocumentExcerpt(x.db, { documentId, keyword: 'alpha', limit: 100, maxResults: 2 }, { root: x.root });
    assert.equal(first.total, 200); assert.equal(first.excerpts.length, 2); assert.equal(first.nextOffset, 2);
    assert.ok(first.excerpts.every(item => item.text.length <= 100));
    const second = await getDocumentExcerpt(x.db, { sha256, keyword: 'alpha', offset: first.nextOffset, limit: 100, maxResults: 2 }, { root: x.root });
    assert.equal(second.excerpts[0].matchStart, first.excerpts[1].matchStart + 'alpha placement evidence. '.length);
    const page = await getDocumentExcerpt(x.db, { documentId, offset: 0, limit: 100 }, { root: x.root });
    assert.equal(page.nextOffset, 100);
    const nextPage = await getDocumentExcerpt(x.db, { documentId, offset: page.nextOffset, limit: 100 }, { root: x.root });
    assert.equal(nextPage.excerpts[0].start, 100);
    const largest = await getDocumentExcerpt(x.db, { documentId, keyword: 'alpha', limit: 1200, maxResults: 3 }, { root: x.root });
    assert.ok(largest.excerpts.every(item => item.text.length <= 1200));
    assert.ok(Buffer.byteLength(JSON.stringify(largest)) < 6000);
    await assert.rejects(getDocumentExcerpt(x.db, { documentId, limit: 1201 }, { root: x.root }), { code: 'INVALID_LIMIT' });
    await assert.rejects(getDocumentExcerpt(x.db, { documentId, maxResults: 4 }, { root: x.root }), { code: 'INVALID_LIMIT' });
  } finally { x.done(); }
});

test('missing and invalid selectors return bounded local errors', async () => {
  const x = fixture();
  try {
    const missing = await getDocumentExcerpt(x.db, { sha256: '0'.repeat(64) }, { root: x.root });
    assert.deepEqual(missing, { state: 'not_found', source: 'local SQLite document cache', networkRequests: 0 });
    await assert.rejects(getDocumentExcerpt(x.db, { sha256: '../secret' }, { root: x.root }), { code: 'INVALID_HASH' });
    await assert.rejects(getDocumentExcerpt(x.db, { documentId: '../secret' }, { root: x.root }), { code: 'INVALID_DOCUMENT_ID' });
    await assert.rejects(getDocumentExcerpt(x.db, {}, { root: x.root }), { code: 'DOCUMENT_SELECTOR_REQUIRED' });
  } finally { x.done(); }
});

test('hash lookup requires a job ID when two cached records share a hash', async () => {
  const x = fixture();
  try {
    const { sha256 } = saveDocument(x, Buffer.from('same content'), 'same content', { name: 'notes.txt', extraction: { format: 'txt', extractedAt: '2026-01-01T00:00:00.000Z' } });
    x.db.prepare('INSERT INTO documents(id,job_id,payload,sha256,local_path,text_path) VALUES(?,?,?,?,?,?)')
      .run('33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444', '{}', sha256, '/unused', '/unused');
    await assert.rejects(getDocumentExcerpt(x.db, { sha256 }, { root: x.root }), { code: 'AMBIGUOUS_DOCUMENT' });
    const exact = await getDocumentExcerpt(x.db, { sha256, jobId }, { root: x.root });
    assert.equal(exact.documentId, documentId);
  } finally { x.done(); }
});

test('legacy page backfill rejects a binary that no longer matches its document hash', async () => {
  const x = fixture();
  try {
    const { localPath } = saveDocument(x, Buffer.from('original text'), 'original text', { name: 'notes.txt' });
    writeFileSync(localPath, 'changed binary', { mode: 0o600 });
    await assert.rejects(getDocumentExcerpt(x.db, { documentId }, { root: x.root }), { code: 'DOCUMENT_CACHE_MISMATCH' });
  } finally { x.done(); }
});

test('document store never follows a tampered DB path or symlink outside its root', async () => {
  const x = fixture();
  try {
    const binary = Buffer.from('safe text');
    const { textPath } = saveDocument(x, binary, 'safe text', { name: 'notes.txt', extraction: { format: 'txt', extractedAt: '2026-01-01T00:00:00.000Z' } });
    x.db.prepare('UPDATE documents SET text_path=? WHERE id=?').run(path.join(x.dir, 'outside.txt'), documentId);
    await assert.rejects(getDocumentExcerpt(x.db, { documentId }, { root: x.root }), { code: 'UNSAFE_DOCUMENT_PATH' });
    x.db.prepare('UPDATE documents SET text_path=? WHERE id=?').run(textPath, documentId);
    writeFileSync(textPath, Buffer.alloc(513 * 1024, 65), { mode: 0o600 });
    await assert.rejects(getDocumentExcerpt(x.db, { documentId }, { root: x.root }), { code: 'TOO_LARGE' });
    rmSync(textPath);
    const outside = path.join(x.dir, 'outside.txt'); writeFileSync(outside, 'private', { mode: 0o600 });
    symlinkSync(outside, textPath);
    await assert.rejects(getDocumentExcerpt(x.db, { documentId }, { root: x.root }), { code: 'UNSAFE_DOCUMENT_PATH' });
  } finally { x.done(); }
});
