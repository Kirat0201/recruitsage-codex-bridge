import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DATA_DIR } from './store.mjs';
import { ApiError } from './http.mjs';
import { extractDocument } from './parse.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/i;
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_BINARY_BYTES = 20 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function readStoredFile(root, row, extension, maxBytes) {
  const recorded = extension === 'txt' ? row.text_path : row.local_path;
  const expected = path.join(root, row.job_id, `${row.sha256}.${extension}`);
  if (typeof recorded !== 'string' || !path.isAbsolute(recorded) || recorded !== expected) throw new ApiError('UNSAFE_DOCUMENT_PATH', 'Document path is outside its authorized cache location');
  let actualRoot, actualFile, rootStat, jobFolderStat;
  try { [actualRoot, actualFile, rootStat, jobFolderStat] = await Promise.all([realpath(root), realpath(expected), lstat(root), lstat(path.join(root, row.job_id))]); }
  catch (error) {
    if (error.code === 'ENOENT') throw new ApiError('DOCUMENT_CACHE_MISSING', 'Cached document file is missing');
    throw new ApiError('DOCUMENT_CACHE_ERROR', 'Cached document could not be inspected');
  }
  if (rootStat.isSymbolicLink() || jobFolderStat.isSymbolicLink() || !actualFile.startsWith(actualRoot + path.sep)) throw new ApiError('UNSAFE_DOCUMENT_PATH', 'Document path escapes its authorized cache');
  if (rootStat.mode & 0o077 || jobFolderStat.mode & 0o077) throw new ApiError('UNSAFE_DOCUMENT_FILE', 'Document cache directories must be owner-only');
  let handle;
  try {
    handle = await open(expected, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.mode & 0o077) throw new ApiError('UNSAFE_DOCUMENT_FILE', 'Cached document is not an owner-only regular file');
    if (stat.size > maxBytes) throw new ApiError('TOO_LARGE', 'Cached document exceeds size limit');
    return await handle.readFile();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error.code === 'ENOENT') throw new ApiError('DOCUMENT_CACHE_MISSING', 'Cached document file is missing');
    throw new ApiError('DOCUMENT_CACHE_ERROR', 'Cached document could not be read');
  } finally { await handle?.close(); }
}

function resolveDocument(db, { documentId, sha256, jobId }) {
  if (!documentId && !sha256) throw new ApiError('DOCUMENT_SELECTOR_REQUIRED', 'Provide a documentId or sha256');
  if (documentId && !UUID.test(documentId)) throw new ApiError('INVALID_DOCUMENT_ID', 'Expected a document UUID');
  if (sha256 && !HASH.test(sha256)) throw new ApiError('INVALID_HASH', 'Expected a 64-character SHA-256 hash');
  if (jobId && !UUID.test(jobId)) throw new ApiError('INVALID_ID', 'Expected a job UUID');
  const fields = 'id,job_id,payload,sha256,local_path,text_path,downloaded_at';
  const normalizedHash = sha256?.toLowerCase();
  const rows = documentId
    ? db.prepare(`SELECT ${fields} FROM documents WHERE id=?`).all(documentId)
    : jobId
      ? db.prepare(`SELECT ${fields} FROM documents WHERE sha256=? AND job_id=? LIMIT 2`).all(normalizedHash, jobId)
      : db.prepare(`SELECT ${fields} FROM documents WHERE sha256=? LIMIT 2`).all(normalizedHash);
  if (rows.length > 1) throw new ApiError('AMBIGUOUS_DOCUMENT', 'Hash matches multiple cached documents; include jobId or documentId');
  const row = rows[0];
  if (!row || jobId && row.job_id !== jobId || normalizedHash && row.sha256 !== normalizedHash) return null;
  if (!UUID.test(row.job_id) || !HASH.test(row.sha256 ?? '')) throw new ApiError('INVALID_DOCUMENT_RECORD', 'Cached document identity is invalid');
  return row;
}

function pageAt(pages, offset) {
  if (!Array.isArray(pages)) return null;
  const match = pages.find(page => Number.isInteger(page.page) && page.start <= offset && offset < page.end);
  return match?.page ?? null;
}

async function extractionMetadata(db, row, root, text) {
  const metadata = JSON.parse(row.payload);
  if (metadata.extraction?.pages || metadata.extraction?.extractedAt) return metadata.extraction;
  // Legacy rows contain a cached binary but no extraction provenance. Reparse it locally once.
  const binary = await readStoredFile(root, row, 'bin', MAX_BINARY_BYTES);
  if (digest(binary) !== row.sha256) throw new ApiError('DOCUMENT_CACHE_MISMATCH', 'Cached binary does not match its SHA-256 identifier');
  const parsed = await extractDocument(binary, metadata.original_name ?? '', metadata.mime_type ?? '');
  if (parsed.text !== text) throw new ApiError('DOCUMENT_CACHE_MISMATCH', 'Cached text differs from the document binary');
  const extraction = {
    format: parsed.format, status: parsed.status, warning: parsed.warning ?? null,
    sources: parsed.sources ?? null, pages: parsed.pages ?? null,
    extractedAt: new Date().toISOString(), extractionProvenance: 'local reparse of cached binary',
    textSha256: digest(Buffer.from(text, 'utf8')),
  };
  db.prepare('UPDATE documents SET payload=? WHERE id=?').run(JSON.stringify({ ...metadata, extraction }), row.id);
  return extraction;
}

function excerpt(text, start, end, pages, matchStart = null, matchEnd = null) {
  const first = pageAt(pages, matchStart ?? start);
  const last = pageAt(pages, Math.max(start, end - 1));
  return {
    text: text.slice(start, end),
    start, end, endExclusive: true, unit: 'characters',
    pageNumber: first, pageEnd: last ?? first,
    ...(matchStart === null ? {} : { matchStart, matchEnd }),
  };
}

export async function getDocumentExcerpt(db, {
  documentId, sha256, jobId, keyword, offset = 0, limit = 700, maxResults = 3,
} = {}, { root = path.join(DATA_DIR, 'documents') } = {}) {
  if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) throw new ApiError('INVALID_OFFSET', 'Offset must be between 0 and 100000');
  if (!Number.isInteger(limit) || limit < 100 || limit > 1200) throw new ApiError('INVALID_LIMIT', 'Excerpt length must be 100 to 1200 characters');
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 3) throw new ApiError('INVALID_LIMIT', 'maxResults must be 1 to 3');
  if (keyword !== undefined && (typeof keyword !== 'string' || keyword.trim().length < 2 || keyword.trim().length > 80)) throw new ApiError('INVALID_KEYWORD', 'Keyword must be 2 to 80 characters');
  const row = resolveDocument(db, { documentId, sha256, jobId });
  if (!row) return { state: 'not_found', source: 'local SQLite document cache', networkRequests: 0 };
  const bytes = await readStoredFile(root, row, 'txt', MAX_TEXT_BYTES);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new ApiError('DOCUMENT_CACHE_MISMATCH', 'Cached text is not valid UTF-8'); }
  if (text.length > 100_000) throw new ApiError('TOO_LARGE', 'Cached extracted text exceeds size limit');
  const extraction = await extractionMetadata(db, row, root, text);
  if (extraction.textSha256 && digest(bytes) !== extraction.textSha256) throw new ApiError('DOCUMENT_CACHE_MISMATCH', 'Cached text checksum mismatch');
  const stored = JSON.parse(row.payload);
  const name = String(stored.original_name ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200) || null;
  let excerpts, nextOffset, total, offsetUnit;
  if (keyword === undefined) {
    const start = Math.min(offset, text.length), end = Math.min(text.length, start + limit);
    excerpts = start < end ? [excerpt(text, start, end, extraction.pages)] : [];
    nextOffset = end < text.length ? end : null;
    total = text.length; offsetUnit = 'characters';
  } else {
    const needle = keyword.trim().toLowerCase(), haystack = text.toLowerCase(), hits = [];
    let position = 0;
    while ((position = haystack.indexOf(needle, position)) !== -1) { hits.push(position); position += needle.length; }
    const selected = hits.slice(offset, offset + maxResults);
    excerpts = selected.map(hit => {
      const start = Math.max(0, hit - Math.floor((limit - needle.length) / 2));
      return excerpt(text, start, Math.min(text.length, start + limit), extraction.pages, hit, hit + needle.length);
    });
    nextOffset = offset + selected.length < hits.length ? offset + selected.length : null;
    total = hits.length; offsetUnit = 'matches';
  }
  return {
    state: 'found', source: 'local extracted document cache', networkRequests: 0,
    jobId: row.job_id, documentId: row.id, sha256: row.sha256, filename: name,
    format: extraction.format ?? null, extractionStatus: extraction.status ?? null,
    extractedAt: extraction.extractedAt ?? null,
    extractionProvenance: extraction.extractionProvenance ?? 'initial local extraction',
    downloadedAt: row.downloaded_at ?? null,
    query: { keyword: keyword?.trim() ?? null, offset, offsetUnit, limit, maxResults: keyword === undefined ? 1 : maxResults },
    total, totalCharacters: text.length, excerpts, nextOffset,
  };
}
