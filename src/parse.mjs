import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import mammoth from 'mammoth';
import { inflateRawSync } from 'node:zlib';
import { ApiError } from './http.mjs';

const MAX_TEXT = 100_000;
const MAX_MEMBER = 10 * 1024 * 1024;
const MAX_ARCHIVE = 30 * 1024 * 1024;
const MAX_DOCUMENT = 20 * 1024 * 1024;
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function pdfText(bytes) {
  let task;
  try {
    task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
    const doc = await task.promise;
    const pages = [];
    let length = 0;
    for (let i = 1; i <= Math.min(doc.numPages, 50) && length < MAX_TEXT; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      const text = content.items.map(item => item.str ?? '').join(' ');
      pages.push(text); length += text.length + 1;
    }
    const text = pages.join('\n').slice(0, MAX_TEXT);
    let cursor = 0;
    const pageSpans = pages.map((page, index) => {
      const span = { page: index + 1, start: Math.min(cursor, text.length), end: Math.min(cursor + page.length, text.length) };
      cursor += page.length + 1;
      return span;
    }).filter(span => span.start < span.end);
    const scanned = text.trim().length < 60;
    return { text, format: 'pdf', status: scanned ? 'scanned_or_empty' : 'extracted', warning: scanned ? 'Little extractable text; PDF may be scanned' : doc.numPages > 50 ? 'Only first 50 pages extracted' : null, pagesRead: pages.length, pages: pageSpans };
  } catch (error) {
    throw new ApiError(error?.name === 'PasswordException' ? 'ENCRYPTED_DOCUMENT' : 'CORRUPT_DOCUMENT', error?.name === 'PasswordException' ? 'Encrypted PDF is not supported' : 'PDF could not be parsed');
  } finally { await task?.destroy().catch(() => {}); }
}

// Central directory sizes are checked before decompression. No archive entry is written to disk.
function zipEntries(bytes) {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ApiError('INVALID_ZIP', 'ZIP central directory is missing');
  const count = bytes.readUInt16LE(eocd + 10);
  const size = bytes.readUInt32LE(eocd + 12), start = bytes.readUInt32LE(eocd + 16);
  if (count > 30 || size === 0xffffffff || start === 0xffffffff || start + size > eocd) throw new ApiError('ZIP_LIMIT', 'ZIP entry or directory limit exceeded');
  const entries = []; let offset = start, expanded = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) throw new ApiError('INVALID_ZIP', 'ZIP directory is corrupt');
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
    const expectedCrc = bytes.readUInt32LE(offset + 16);
    const compressed = bytes.readUInt32LE(offset + 20), length = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > start + size || flags & 1 || ![0, 8].includes(method) || compressed === 0xffffffff || length === 0xffffffff || localOffset === 0xffffffff) throw new ApiError('UNSUPPORTED_ZIP', 'Unsupported ZIP entry');
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').some(part => part === '..' || part === '.')) throw new ApiError('UNSAFE_ZIP', 'Unsafe ZIP entry name');
    if (length > MAX_MEMBER || (expanded += length) > MAX_ARCHIVE || (compressed > 0 && length / compressed > 1000)) throw new ApiError('ZIP_LIMIT', 'ZIP expansion limit exceeded');
    if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new ApiError('INVALID_ZIP', 'ZIP local header is corrupt');
    const dataStart = localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
    if (dataStart + compressed > start) throw new ApiError('INVALID_ZIP', 'ZIP member overlaps its directory');
    entries.push({ name, method, compressed, length, dataStart, expectedCrc });
    offset = next;
  }
  return entries;
}

function zipMember(bytes, entry) {
  const raw = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressed);
  let output;
  try { output = entry.method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: MAX_MEMBER }); }
  catch { throw new ApiError('CORRUPT_DOCUMENT', 'ZIP member could not be decompressed'); }
  if (output.length !== entry.length) throw new ApiError('INVALID_ZIP', 'ZIP member size mismatch');
  if (crc32(output) !== entry.expectedCrc) throw new ApiError('CORRUPT_DOCUMENT', 'ZIP member checksum mismatch');
  return output;
}

export function validateXlsxArchive(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length > 2 * 1024 * 1024 || bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) throw new ApiError('INVALID_XLSX', 'XLSX size or signature is invalid');
  const entries = zipEntries(bytes);
  const names = new Set(entries.map(entry => entry.name));
  if (!names.has('[Content_Types].xml') || !names.has('xl/workbook.xml') || ![...names].some(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))) throw new ApiError('INVALID_XLSX', 'Required XLSX package parts are missing');
  if (entries.some(entry => /(?:vbaProject|externalLinks|embeddings|activeX)/i.test(entry.name))) throw new ApiError('UNSAFE_XLSX', 'XLSX contains unsupported active or external content');
  for (const entry of entries) {
    const member = zipMember(bytes, entry);
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name) && /<(?:[A-Za-z0-9_]+:)?f(?:\s|>)/.test(member.toString('utf8'))) throw new ApiError('UNSAFE_XLSX', 'XLSX formulas are not accepted for shortlist evidence');
  }
  return { entries: entries.length };
}

async function archiveText(bytes) {
  const entries = zipEntries(bytes), parts = [], sources = [];
  let used = 0;
  for (const entry of entries) {
    if (!/\.(pdf|docx|txt|md|csv|json)$/i.test(entry.name)) continue;
    const parsed = await extractDocument(zipMember(bytes, entry), entry.name, '', 1);
    const remaining = MAX_TEXT - used;
    if (remaining <= 0) break;
    const part = `### ${entry.name}\n${parsed.text}`.slice(0, remaining);
    parts.push(part); used += part.length + 2;
    sources.push({ member: entry.name, format: parsed.format, status: parsed.status, characters: parsed.text.length });
  }
  return { text: parts.join('\n\n').slice(0, MAX_TEXT), format: 'zip', status: parts.length ? 'extracted' : 'no_supported_entries', warning: parts.length ? null : 'No supported files found in ZIP', sources };
}

export async function extractDocument(bytes, filename, mime = '', depth = 0) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length > MAX_DOCUMENT) throw new ApiError('TOO_LARGE', 'Document exceeds 20 MB');
  const ext = path.extname(filename).toLowerCase();
  const type = mime.split(';')[0].trim().toLowerCase();
  const pdf = bytes.subarray(0, 5).toString() === '%PDF-';
  const zip = bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50;
  const kind = ext || (mime.includes('application/pdf') ? '.pdf' : mime.includes('application/zip') ? '.zip' : '');
  if ((type === 'application/pdf' && kind !== '.pdf') ||
      (type === 'application/zip' && !['.zip', '.docx'].includes(kind)) ||
      (type.includes('wordprocessingml.document') && kind !== '.docx')) {
    throw new ApiError('INVALID_DOCUMENT', 'Document MIME type and filename disagree');
  }
  if (kind === '.pdf') {
    if (!pdf || zip) throw new ApiError('INVALID_DOCUMENT', 'PDF signature mismatch');
    return pdfText(bytes);
  }
  if (kind === '.zip') {
    if (!zip) throw new ApiError('INVALID_DOCUMENT', 'ZIP signature mismatch');
    if (depth) throw new ApiError('ZIP_LIMIT', 'Nested archives are unsupported');
    return archiveText(bytes);
  }
  if (kind === '.docx') {
    if (!zip) throw new ApiError('INVALID_DOCUMENT', 'DOCX signature mismatch');
    const entries = zipEntries(bytes);
    if (!entries.some(entry => entry.name === '[Content_Types].xml') || !entries.some(entry => entry.name === 'word/document.xml')) throw new ApiError('INVALID_DOCUMENT', 'DOCX package entries are missing');
    try {
      const result = await mammoth.extractRawText({ buffer: bytes });
      return { text: result.value.slice(0, MAX_TEXT), format: 'docx', status: result.value.trim() ? 'extracted' : 'empty', warning: result.value.trim() ? null : 'DOCX contains no extractable text' };
    } catch { throw new ApiError('CORRUPT_DOCUMENT', 'DOCX could not be parsed'); }
  }
  if (['.txt', '.md', '.csv', '.json'].includes(kind)) {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new ApiError('INVALID_DOCUMENT', 'Text document is not UTF-8'); }
    if (text.includes('\0')) throw new ApiError('INVALID_DOCUMENT', 'Text document contains binary data');
    return { text: text.slice(0, MAX_TEXT), format: kind.slice(1), status: text.trim() ? 'extracted' : 'empty', warning: null };
  }
  throw new ApiError('UNSUPPORTED_FORMAT', `Unsupported document format: ${ext || mime || 'unknown'}`);
}
