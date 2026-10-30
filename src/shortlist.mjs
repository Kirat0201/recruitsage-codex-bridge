import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, rename, unlink, lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gmailClient } from './gmail-http.mjs';
import { normalizeAccountId } from './gmail-auth.mjs';
import { loadStudentIdentity } from './student-identity.mjs';
import { parseShortlistWorkbook, matchStudentInWorkbook } from './shortlist-xlsx.mjs';
import { extractDocument, validateXlsxArchive } from './parse.mjs';
import { DATA_DIR, jobRecord } from './store.mjs';
import { getApplicationStatus } from './jobs.mjs';
import { cachedGmailAttachment, cachedGmailAttachmentByMetadata, saveGmailAttachment, saveSelectionEvent, listSelectionEvents } from './gmail-store.mjs';

const ROOT = path.join(DATA_DIR, 'gmail/attachments');
const MAX_PARTS = 100;
const EXTENSIONS = new Set(['.xlsx', '.pdf', '.zip', '.docx']);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const norm = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
const header = (raw, name) => raw.payload?.headers?.find(x => x.name?.toLowerCase() === name)?.value ?? '';
function parts(root) {
  const result = [], queue = [{ part: root, depth: 0 }];
  while (queue.length) {
    const { part, depth } = queue.shift();
    if (!part || depth > 10 || result.length >= MAX_PARTS) throw Object.assign(new Error('Gmail MIME structure exceeds limits'), { code: 'MIME_LIMIT' });
    result.push(part);
    for (const child of part.parts ?? []) queue.push({ part: child, depth: depth + 1 });
  }
  return result;
}
export function discoverGmailAttachments(raw) {
  return parts(raw.payload).filter(part => part.body?.attachmentId && part.filename).map(part => ({
    attachmentId: part.body.attachmentId, filename: String(part.filename).slice(0, 240),
    mime: String(part.mimeType ?? '').toLowerCase(), declaredSize: Number(part.body.size ?? 0),
    extension: path.extname(part.filename).toLowerCase(),
  }));
}
export function stageFrom(filename, subject, body = '') {
  const source = `${filename} ${subject}`;
  const stages = [
    ['offer', /\boffer\b/i], ['final_interview', /\bfinal\s+interview\b/i],
    ['technical_interview', /\btechnical\s+(?:interview|round)\b/i],
    ['hr_interview', /\bHR\s+(?:interview|round)\b/i],
    ['gd', /(?:^|[^A-Za-z])GD(?:$|[^A-Za-z])|group\s+discussion/i], ['oa', /(?:^|[^A-Za-z])OA(?:$|[^A-Za-z])|online\s+assessment|aptitude\s+test/i],
  ].filter(([, pattern]) => pattern.test(source));
  if (stages.length !== 1 || !/shortlist|selected|qualified/i.test(`${filename} ${body}`)) return null;
  return stages[0][0];
}
export function shortlistCandidate(message) {
  const attachments = (message.attachments ?? []).filter(item => EXTENSIONS.has(item.extension));
  return attachments.length > 0 && /shortlist|selected|qualified/i.test(`${message.subject} ${message.bodyText} ${attachments.map(item => item.filename).join(' ')}`);
}
export function resolveShortlistJob(db, message) {
  const text = `${message.subject} ${message.bodyText}`.toLowerCase();
  const subject = norm(message.subject);
  const jobs = db.prepare('SELECT id,payload FROM jobs WHERE present=1').all().map(row => JSON.parse(row.payload));
  const byId = jobs.filter(job => text.includes(job.id.toLowerCase()));
  if (byId.length === 1) return { jobId: byId[0].id, basis: 'exact_job_id' };
  if (byId.length > 1) return { state: 'needs_review', reason: 'ambiguous_job_ids' };
  const matches = jobs.filter(job => {
    const companyToken = norm(job.company).split(' ')[0];
    const roleParts = String(job.title ?? '').split(/[-–/]/).map(norm).filter(x => x.length >= 8);
    return companyToken?.length >= 5 && subject.includes(companyToken) && roleParts.some(role => subject.includes(role));
  });
  return matches.length === 1 ? { jobId: matches[0].id, basis: 'unique_company_and_role_fragment' } :
    { state: 'needs_review', reason: matches.length ? 'ambiguous_job_match' : 'job_match_missing' };
}
function reportedDate(filename, timestamp) {
  const match = filename.match(/(?:^|[^0-9])(\d{1,2})(?:st|nd|rd|th)?\s*(?:&|and)\s*(\d{1,2})(?:st|nd|rd|th)?\s*(Oct|October)\b/i);
  if (!match) return null;
  const year = new Date(timestamp).getUTCFullYear();
  return `${year}-10-${match[1].padStart(2, '0')}/${year}-10-${match[2].padStart(2, '0')}`;
}
function jobAssociation(db, jobId, subject, body) {
  const record = jobRecord(db, jobId);
  if (!record?.present) throw Object.assign(new Error('RecruitSage job is not in the current local snapshot'), { code: 'JOB_NOT_CACHED' });
  const job = record.job, source = `${subject} ${body}`.toLowerCase();
  if (source.includes(jobId.toLowerCase())) return { job, record, basis: 'exact_job_id' };
  const companyToken = norm(job.company).split(' ')[0];
  const roleParts = String(job.title ?? '').split(/[-–/]/).map(norm).filter(x => x.length >= 8);
  const role = roleParts.find(x => norm(subject).includes(x));
  if (!companyToken || companyToken.length < 5 || !norm(subject).includes(companyToken) || !role) return null;
  const candidates = db.prepare('SELECT payload FROM jobs WHERE present=1').all().map(row => JSON.parse(row.payload))
    .filter(candidate => norm(candidate.company).split(' ')[0] === companyToken && String(candidate.title ?? '').split(/[-–/]/).map(norm).includes(role));
  return candidates.length === 1 ? { job, record, basis: 'unique_company_and_role_fragment' } : null;
}
async function cachedBytes(db, meta, accountId, messageId, root) {
  const cached = cachedGmailAttachment(db, accountId, messageId, meta.attachmentId) ?? cachedGmailAttachmentByMetadata(db, accountId, messageId, meta);
  if (!cached?.sha256 || !/^[0-9a-f]{64}$/.test(cached.sha256) || cached.state !== 'stored') return null;
  const file = path.join(root, `${cached.sha256}${meta.extension}`);
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.size > 20 * 1024 * 1024) return null;
    const bytes = await readFile(file);
    return sha(bytes) === cached.sha256 ? { bytes, sha256: cached.sha256, file, source: 'local attachment cache' } : null;
  } catch { return null; }
}
async function attachmentBytes(db, client, meta, accountId, messageId, root, onDownload = () => {}) {
  const max = meta.extension === '.xlsx' ? 2 * 1024 * 1024 : 20 * 1024 * 1024;
  if (!Number.isSafeInteger(meta.declaredSize) || meta.declaredSize < 1 || meta.declaredSize > max) throw Object.assign(new Error('Attachment size exceeds the allowed limit'), { code: 'ATTACHMENT_LIMIT' });
  const prior = await cachedBytes(db, meta, accountId, messageId, root);
  if (prior) return prior;
  onDownload();
  const reply = await client.getAttachment(accountId, messageId, meta.attachmentId);
  if (typeof reply.data !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(reply.data) || reply.data.length > Math.ceil(max * 4 / 3) + 4) throw Object.assign(new Error('Gmail attachment encoding is invalid'), { code: 'INVALID_ATTACHMENT' });
  const bytes = Buffer.from(reply.data, 'base64url');
  if (bytes.length !== meta.declaredSize || bytes.length !== reply.size || bytes.length > max) throw Object.assign(new Error('Gmail attachment size mismatch'), { code: 'INVALID_ATTACHMENT' });
  if (meta.extension === '.xlsx') validateXlsxArchive(bytes);
  else await extractDocument(bytes, meta.filename, meta.mime);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const hash = sha(bytes), file = path.join(root, `${hash}${meta.extension}`), temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, file);
  } catch (error) { await unlink(temp).catch(() => {}); throw error; }
  saveGmailAttachment(db, { ...meta, accountId, messageId, sha256: hash, localPath: file, state: 'stored', fetchedAt: new Date().toISOString() });
  return { bytes, sha256: hash, file, source: 'Gmail API attachment download' };
}
function matchText(parsed, profile) {
  const email = profile.universityEmail.toLowerCase();
  const text = parsed.text.toLowerCase(), at = text.indexOf(email);
  if (at >= 0 && text.indexOf(email, at + email.length) < 0) {
    const page = parsed.pages?.find(x => x.start <= at && at < x.end)?.page ?? null;
    return { outcome: 'shortlisted', identifierType: 'university_email', matches: [{ page, start: at, end: at + email.length, columns: [] }] };
  }
  return { outcome: at >= 0 ? 'needs_review' : 'unknown', reason: at >= 0 ? 'duplicate_identity' : 'text_identifier_absent', matches: [] };
}

export async function analyzeShortlistEmail(db, { accountId, messageId, jobId } = {}, { client = gmailClient, identityRoot, attachmentRoot = ROOT } = {}) {
  accountId = normalizeAccountId(accountId);
  const profile = await loadStudentIdentity(accountId, { root: identityRoot });
  if (!profile) throw Object.assign(new Error('Configure a verified local student identity first'), { code: 'IDENTITY_REQUIRED' });
  const raw = await client.getMessage(accountId, messageId, 'full');
  if (raw.id !== messageId) throw Object.assign(new Error('Gmail message identity mismatch'), { code: 'INVALID_MESSAGE' });
  const subject = header(raw, 'subject'), from = header(raw, 'from');
  const body = parts(raw.payload).filter(part => part.mimeType === 'text/plain' && part.body?.data)
    .map(part => Buffer.from(part.body.data, 'base64url').toString('utf8')).join(' ').slice(0, 16_000);
  const associated = jobAssociation(db, jobId, subject, body);
  if (!associated) return { state: 'needs_review', reason: 'job_association_unverified', accountId, messageId, jobId, networkRequests: 1 };
  const candidates = discoverGmailAttachments(raw).filter(item => EXTENSIONS.has(item.extension));
  if (!candidates.length) return { state: 'no_supported_attachments', accountId, messageId, jobId, networkRequests: 1 };
  if (candidates.length > 5) return { state: 'needs_review', reason: 'too_many_supported_attachments', count: candidates.length, networkRequests: 1 };
  const eventTimestamp = new Date(Number(raw.internalDate)).toISOString();
  const results = []; let networkRequests = 1;
  for (const meta of candidates) {
    const stage = stageFrom(meta.filename, subject, body);
    if (!stage) { results.push({ state: 'needs_review', reason: 'stage_or_shortlist_announcement_unclear', filename: meta.filename }); continue; }
    try {
      const attachment = await attachmentBytes(db, client, meta, accountId, messageId, attachmentRoot, () => { networkRequests++; });
      const evidence = meta.extension === '.xlsx'
        ? matchStudentInWorkbook(await parseShortlistWorkbook(attachment.bytes), profile)
        : matchText(await extractDocument(attachment.bytes, meta.filename, meta.mime), profile);
      const stableEventId = sha(Buffer.from([accountId, messageId, meta.filename, jobId, stage, attachment.sha256].join('\0')));
      const eventId = db.prepare('SELECT event_id FROM selection_events WHERE account_id=? AND message_id=? AND job_id=? AND stage=? AND document_hash=? ORDER BY event_id LIMIT 1')
        .get(accountId, messageId, jobId, stage, attachment.sha256)?.event_id ?? stableEventId;
      const location = (evidence.matches.length ? evidence.matches : evidence.nameOnlyLocations ?? []).map(match => ({ sheet: match.sheet ?? null, row: match.row ?? null,
        columns: match.columns ?? (match.nameColumn ? [{ index: match.nameColumn, type: 'name_support_only' }] : []),
        page: match.page ?? null, start: match.start ?? null, end: match.end ?? null }));
      const event = { eventId, accountId, jobId, messageId, attachmentId: meta.attachmentId,
        documentHash: attachment.sha256, filename: meta.filename, company: associated.job.company,
        role: associated.job.title, stage, outcome: evidence.outcome, eventTimestamp,
        reportedEventDate: reportedDate(meta.filename, eventTimestamp),
        releaseKind: /\b(?:revised|updated|corrected|supersed(?:ed|ing))\b/i.test(`${subject} ${meta.filename}`) ? 'revised' : 'initial',
        identifierType: evidence.identifierType ?? null, location,
        uncertainty: evidence.reason ?? null, associationBasis: associated.basis,
        sourceRef: `gmail:${accountId}/${messageId}/attachment:${attachment.sha256}`,
        attachmentSource: attachment.source, evaluatedAt: new Date().toISOString() };
      event.nextAction = evidence.outcome === 'shortlisted' ? `Check official ${stage.toUpperCase()} schedule and subsequent notices` :
        evidence.outcome === 'needs_review' ? 'Review identifier evidence in the source document' : 'No selection action inferred';
      const app = getApplicationStatus(db, jobId);
      const docketItem = { accountId, messageId, jobId, company: associated.job.company, role: associated.job.title,
        confidence: associated.basis === 'exact_job_id' ? 'exact_identity' : 'unique_role_fragment',
        matchBasis: associated.basis, unresolvedConflicts: [], applicationStatus: app?.status ?? null,
        applicationStatusSource: app ? 'RecruitSage application snapshot' : 'no RecruitSage application row',
        selectionStatus: null, assessmentDate: null, interviewDate: null,
        deadline: associated.job.applicationDeadline ?? null, nextActionableEvent: null,
        email: { subject, from, internalDate: eventTimestamp, threadId: raw.threadId },
        evidence: { recruitsage: { jobId, source: associated.job.source ?? 'job bundle cache', syncedAt: associated.record.lastSeen },
          gmail: { accountId, messageId, sourceRef: `gmail:${accountId}/${messageId}`, fetchedAt: new Date().toISOString() } },
        freshness: { recruitsageSnapshotAt: associated.record.lastSeen, gmailFetchedAt: new Date().toISOString() } };
      saveSelectionEvent(db, event, docketItem);
      results.push({ state: 'analyzed', ...event });
    } catch (error) {
      saveGmailAttachment(db, { ...meta, accountId, messageId, state: 'error', fetchedAt: new Date().toISOString() });
      results.push({ state: 'extraction_error', filename: meta.filename, code: error.code ?? 'ATTACHMENT_ERROR' });
    }
  }
  return { accountId, messageId, jobId, source: 'Gmail API message with local attachment cache',
    networkRequests,
    results: results.map(({ attachmentId, ...safe }) => safe) };
}

export function getShortlistHistory(db, { accountId, jobId, limit = 20, offset = 0 }) {
  return listSelectionEvents(db, { accountId, jobId, limit, offset });
}
