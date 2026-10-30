import { rpc, table, downloadObject, ApiError } from './http.mjs';
import { cachedJob, listJobs, metadata, saveBundle, saveEligibility, classifiedJobs, DATA_DIR } from './store.mjs';
import { extractDocument } from './parse.mjs';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { authManager } from './auth.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function jobId(id) { if (!uuid.test(id)) throw new ApiError('INVALID_ID', 'Expected a job UUID'); return id; }
export function normalize(bundle) {
  const companies = new Map((bundle.companies ?? []).map(c => [c.id, c]));
  const apps = new Map((bundle.applicationRows ?? []).map(a => [a.job_id, a]));
  return (bundle.mappings ?? []).filter(m => m.job_id).map(m => {
    const j = m.jobs_posted ?? {}; const a = apps.get(m.job_id); const availability = j.job_availabilities?.[0] ?? {};
    return { id: m.job_id, title: j.title ?? null, company: companies.get(j.company_id)?.name ?? a?.jobs_posted?.companies?.name ?? null, location: j.location ?? null, jobType: j.job_type ?? null, createdAt: m.created_at ?? j.created_at ?? null, applicationDeadline: availability.application_deadline ?? null, allowsApplications: availability.allow_student_applications ?? null, applied: Boolean(a), applicationStatus: a?.status ?? null, eligibilityRules: j.job_eligibilities ?? [], salaryOptions: j.job_salaries ?? [], source: 'get_student_job_bundle_page' };
  });
}

export async function fetchBundle({ requestRpc = rpc, maxPages = 20 } = {}) {
  let cursor = null, revision = null, totalJobs = null;
  const mappings = new Map(), companies = new Map(), applications = new Map(), cursors = new Set();
  for (let page = 0; page < maxPages; page++) {
    const body = cursor ? { p_limit: 150, p_after_created_at: cursor.createdAt, p_after_job_id: cursor.jobId, p_revision: cursor.revision } : { p_limit: 50 };
    const result = await requestRpc('get_student_job_bundle_page', body);
    if (!Array.isArray(result?.mappings)) throw new ApiError('SCHEMA_CHANGED', 'Job bundle response shape changed');
    if (revision !== null && result.revision !== revision) throw new ApiError('REVISION_CHANGED', 'Jobs changed during pagination; retry sync');
    revision = result.revision ?? revision; totalJobs = result.totalJobs ?? totalJobs;
    for (const m of result.mappings) if (m.job_id) mappings.set(m.job_id, m);
    for (const c of result.companies ?? []) if (c.id) companies.set(c.id, c);
    for (const a of result.applicationRows ?? []) if (a.job_id) applications.set(a.job_id, a);
    if (!result.nextCursor) {
      if (typeof totalJobs === 'number' && mappings.size !== totalJobs) throw new ApiError('INCOMPLETE_PAGE', `Bundle returned ${mappings.size} of ${totalJobs} jobs`);
      return { mappings: [...mappings.values()], companies: [...companies.values()], applicationRows: [...applications.values()], revision, totalJobs, requests: page + 1 };
    }
    cursor = result.nextCursor;
    const fingerprint = JSON.stringify(cursor);
    if (cursors.has(fingerprint)) throw new ApiError('CURSOR_LOOP', 'Job pagination cursor repeated');
    cursors.add(fingerprint);
  }
  throw new ApiError('PAGE_LIMIT', 'Job bundle exceeded pagination limit');
}

export async function syncJobs(db, options = {}) {
  const last = metadata(db, 'syncedAt');
  if (!options.force && last && metadata(db, 'eligibilityCheckedAt') && Date.now() - Date.parse(last) < (options.minIntervalMs ?? 5 * 60_000)) {
    return { skipped: true, reason: 'recent sync', syncedAt: last, requests: 0 };
  }
  const bundle = await fetchBundle(options);
  const check = await fetchEligibility(bundle.mappings.map(m => m.job_id), options);
  const result = saveBundle(db, bundle, normalize(bundle));
  saveEligibility(db, check.rows);
  const appliedIds = new Set((bundle.applicationRows ?? []).map(a => a.job_id));
  return { ...result, reportedTotal: bundle.totalJobs, eligibilityChecked: check.rows.length, available: check.rows.filter(r => r.eligible && !r.closed && !appliedIds.has(r.jobId)).length, closed: check.rows.filter(r => r.closed).length, requests: bundle.requests + check.requests };
}
export const listAppliedJobs = (db, options) => listJobs(db, { ...options, filter: 'applied' });
export const listNewJobs = (db, options) => listJobs(db, { ...options, filter: 'new' });
export const listAvailableJobs = (db, options) => classifiedJobs(db, { ...options, kind: 'available' });
export const listClosedJobs = (db, options) => classifiedJobs(db, { ...options, kind: 'closed' });

export async function fetchEligibility(ids, { requestRpc = rpc, batchSize = 50, email: suppliedEmail } = {}) {
  let email = suppliedEmail;
  if (!email) {
    const { accessToken } = await authManager.valid();
    try { email = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url')).email; } catch { throw new ApiError('INVALID_TOKEN', 'Access token lacks a readable email claim'); }
  }
  if (typeof email !== 'string' || !email.includes('@')) throw new ApiError('INVALID_TOKEN', 'Access token lacks an email claim');
  const rows = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    const part = ids.slice(i, i + batchSize);
    const response = await requestRpc('batch_check_job_eligibility_cached', { p_job_ids: part, p_student_email: email });
    if (!Array.isArray(response) || response.length !== part.length) throw new ApiError('ELIGIBILITY_INCOMPLETE', 'Eligibility RPC returned an incomplete batch');
    const expected = new Set(part);
    for (const item of response) {
      if (!expected.delete(item.job_id) || typeof item.result?.eligible !== 'boolean') throw new ApiError('ELIGIBILITY_SCHEMA', 'Eligibility RPC returned unexpected job IDs or flags');
      rows.push({ jobId: item.job_id, eligible: item.result.eligible, closed: item.result.closed === true, reasons: Array.isArray(item.result.reasons) ? item.result.reasons.filter(x => typeof x === 'string') : [] });
    }
    if (expected.size) throw new ApiError('ELIGIBILITY_INCOMPLETE', 'Eligibility RPC omitted job IDs');
  }
  return { rows, requests: Math.ceil(ids.length / batchSize) };
}
export async function getJobDetails(id) { const rows = await table('jobs_posted', { select: '*,companies(*)', id: `eq.${jobId(id)}` }); return rows?.[0] ?? null; }
export async function getJobAttachments(id) { return table('job_jd_files', { select: '*', job_id: `eq.${jobId(id)}`, order: 'ordinal.asc' }); }
export async function getLiveApplicationStatus(id) {
  const rows = await table('applications', { select: 'id,job_id,status,created_at,updated_at', job_id: `eq.${jobId(id)}`, limit: 2 });
  if (!Array.isArray(rows) || rows.length > 1) throw new ApiError('APPLICATION_SCHEMA', 'Unexpected application response for job');
  const row = rows[0];
  return { state: row ? 'record' : 'no_record', id: row?.id ?? null, status: row?.status ?? null, appliedAt: row?.created_at ?? null, updatedAt: row?.updated_at ?? null, source: 'applications', verifiedAt: new Date().toISOString() };
}
export function getApplicationStatus(db, id) { jobId(id); const row = db.prepare('SELECT payload FROM applications WHERE job_id=?').get(id); if (!row) return null; const a = JSON.parse(row.payload); return { jobId: id, status: a.status ?? null, appliedAt: a.created_at ?? null, source: 'cached application row' }; }
export function getRecruitmentRounds(db, id) { jobId(id); const row = db.prepare('SELECT payload FROM applications WHERE job_id=?').get(id); if (!row) return { jobId: id, rounds: [], source: 'no cached application' }; const a = JSON.parse(row.payload); return { jobId: id, rounds: (a.round_candidates ?? []).map(r => ({ roundId: r.round_id, status: r.status, createdAt: r.created_at, round: r.interview_rounds ?? null, slot: r.interview_slots ?? null })), source: 'cached application bundle' }; }

export async function downloadJobDescription(db, id, { directory = path.join(DATA_DIR, 'documents'), files: suppliedFiles, continueOnError = false } = {}) {
  jobId(id);
  if (!cachedJob(db, id) && !suppliedFiles) throw new ApiError('UNKNOWN_JOB', 'Sync jobs before downloading an attachment');
  const files = suppliedFiles ?? await getJobAttachments(id);
  const outputs = [];
  for (const f of files ?? []) {
    if (!f.id || !f.file_path) continue;
    try {
    const prior = db.prepare('SELECT payload,sha256,local_path,text_path FROM documents WHERE id=?').get(f.id);
    if (prior?.sha256 && JSON.parse(prior.payload).file_path === f.file_path) {
      try { await readFile(prior.local_path); const text = await readFile(prior.text_path, 'utf8'); outputs.push({ fileId: f.id, name: f.original_name, cached: true, sha256: prior.sha256, characters: text.length, textPath: prior.text_path, extraction: JSON.parse(prior.payload).extraction ?? null }); continue; } catch { /* cache missing */ }
    }
    if (f.size_bytes > 20 * 1024 * 1024) throw new ApiError('TOO_LARGE', 'Attachment exceeds 20 MB');
    const { bytes, mime } = await downloadObject(f.file_path);
    const parsed = await extractDocument(bytes, f.original_name ?? '', mime);
    const folder = path.resolve(directory, id); await mkdir(folder, { recursive: true, mode: 0o700 });
    const digest = createHash('sha256').update(bytes).digest('hex');
    const binaryPath = path.join(folder, `${digest}.bin`), textPath = path.join(folder, `${digest}.txt`);
    await writeFile(binaryPath, bytes, { mode: 0o600 }); await writeFile(textPath, parsed.text, { mode: 0o600 });
    const extraction = { format: parsed.format, status: parsed.status, warning: parsed.warning ?? null,
      sources: parsed.sources ?? null, pages: parsed.pages ?? null, extractedAt: new Date().toISOString(),
      textSha256: createHash('sha256').update(parsed.text).digest('hex') };
    db.prepare('INSERT INTO documents(id,job_id,payload,sha256,local_path,text_path,downloaded_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,sha256=excluded.sha256,local_path=excluded.local_path,text_path=excluded.text_path,downloaded_at=excluded.downloaded_at').run(f.id, id, JSON.stringify({ ...f, extraction }), digest, binaryPath, textPath, new Date().toISOString());
    outputs.push({ fileId: f.id, name: f.original_name, cached: false, bytes: bytes.length, characters: parsed.text.length, sha256: digest, extraction, textPath });
    } catch (error) {
      if (!continueOnError) throw error;
      outputs.push({ fileId: f.id, name: f.original_name, error: { code: error.code ?? 'EXTRACTION_FAILED', message: error.message } });
    }
  }
  return outputs;
}
