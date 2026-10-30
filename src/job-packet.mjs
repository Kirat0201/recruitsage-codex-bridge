import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { ApiError } from './http.mjs';
import { jobRecord, metadata } from './store.mjs';
import { getJobDetails, getJobAttachments, getLiveApplicationStatus, getApplicationStatus, getRecruitmentRounds, downloadJobDescription } from './jobs.mjs';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTO_MAX_AGE_MS = 15 * 60_000;
const excerpt = (value, limit) => {
  if (value === null || value === undefined) return { text: null, truncated: false };
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { text: text.slice(0, limit), truncated: text.length > limit };
};
const stateFor = error => error?.code === 'ACCESS_DENIED' || error?.status === 403 ? 'unauthorized' : 'error';
const resourceError = error => ({ state: stateFor(error), code: error?.code ?? 'FETCH_FAILED' });

function cachedDocuments(db, jobId) {
  return db.prepare('SELECT id,payload,sha256,text_path,downloaded_at FROM documents WHERE job_id=? ORDER BY id').all(jobId).map(row => ({
    id: row.id, metadata: JSON.parse(row.payload), sha256: row.sha256, textPath: row.text_path, downloadedAt: row.downloaded_at,
  }));
}

async function documentResults(files, records, includeDocuments, maxExcerptChars) {
  if (!includeDocuments) return { state: 'not_requested', files: files.map(file => ({ ...file, extraction: { state: 'not_requested' } })) };
  const byId = new Map(records.map(record => [record.id, record]));
  const seenHashes = new Map();
  const outputs = [];
  for (const file of files) {
    const record = byId.get(file.id);
    if (!record) { outputs.push({ ...file, extraction: { state: 'not_cached' } }); continue; }
    if (record.error) { outputs.push({ ...file, extraction: { state: stateFor(record.error), code: record.error.code } }); continue; }
    if (!record.sha256 || !record.textPath) { outputs.push({ ...file, extraction: { state: 'not_cached' } }); continue; }
    if (seenHashes.has(record.sha256)) {
      outputs.push({ ...file, extraction: { state: 'duplicate', sha256: record.sha256, duplicateOf: seenHashes.get(record.sha256) } });
      continue;
    }
    seenHashes.set(record.sha256, file.id);
    try {
      const text = await readFile(record.textPath, 'utf8');
      const details = record.metadata.extraction ?? {};
      outputs.push({ ...file, extraction: {
        state: details.status ?? (text.trim().length < 60 ? 'scanned_or_empty' : 'extracted'),
        format: details.format ?? null, sha256: record.sha256, characters: text.length,
        excerpt: excerpt(text, maxExcerptChars), evidenceRef: `document:${record.sha256}`,
        contentSource: 'local document cache', downloadedAt: record.downloadedAt,
        sources: details.sources ?? null, warning: details.warning ?? null,
      } });
    } catch { outputs.push({ ...file, extraction: { state: 'cache_missing', sha256: record.sha256 } }); }
  }
  return { state: files.length ? 'available' : 'none', files: outputs };
}

function fileSummary(file, retrievedAt) {
  return { id: file.id, name: file.original_name ?? null, mime: file.mime_type ?? null, bytes: file.size_bytes ?? null,
    source: 'job_jd_files', retrievedAt };
}

function applicationFromCache(db, id, syncedAt) {
  const cached = getApplicationStatus(db, id);
  return cached ? { state: 'record', status: cached.status, appliedAt: cached.appliedAt, source: 'application bundle cache', verifiedAt: syncedAt }
    : { state: syncedAt ? 'no_record_in_snapshot' : 'not_cached', status: null, source: 'application bundle cache', verifiedAt: syncedAt };
}

export async function getJobPacket(db, { jobId, freshness = 'auto', includeDocuments = false, maxExcerptChars = 1200 } = {}, deps = {}) {
  if (!ID.test(jobId ?? '')) throw new ApiError('INVALID_ID', 'Expected a job UUID');
  if (!['live', 'cache', 'auto'].includes(freshness)) throw new ApiError('INVALID_FRESHNESS', 'Expected live, cache, or auto');
  if (!Number.isInteger(maxExcerptChars) || maxExcerptChars < 100 || maxExcerptChars > 2000) throw new ApiError('INVALID_LIMIT', 'Excerpt limit must be 100 to 2000');
  const cached = jobRecord(db, jobId);
  const snapshot = db.prepare('SELECT payload,fetched_at FROM job_packets WHERE job_id=?').get(jobId);
  const age = snapshot ? Date.now() - Date.parse(snapshot.fetched_at) : Infinity;
  const savedFiles = cachedDocuments(db, jobId);
  const snapshotFiles = snapshot ? JSON.parse(snapshot.payload).files ?? [] : [];
  const cacheComplete = !includeDocuments || snapshotFiles.length === 0 || snapshotFiles.every(file => savedFiles.some(record => record.id === file.id && record.textPath && existsSync(record.textPath)));
  const mode = freshness === 'auto' ? snapshot && cached?.present && age >= 0 && age <= AUTO_MAX_AGE_MS && cacheComplete ? 'cache' : 'live' : freshness;
  if (mode === 'cache' && !cached && !snapshot) return { jobId, state: 'not_cached', freshness: { requested: freshness, actual: 'cache', snapshotAt: null }, missing: ['job', 'details', 'attachments', 'application', 'eligibility'] };

  let detail = snapshot ? JSON.parse(snapshot.payload).detail : null;
  let files = snapshotFiles;
  let application = snapshot ? JSON.parse(snapshot.payload).application : applicationFromCache(db, jobId, metadata(db, 'syncedAt'));
  let fetchedAt = snapshot?.fetched_at ?? null;
  let attachmentState = snapshot ? 'verified' : 'not_cached';
  if (mode === 'live') {
    // A live packet always makes a real authenticated detail request. Failure is explicit.
    detail = await (deps.getDetails ?? getJobDetails)(jobId);
    fetchedAt = new Date().toISOString();
    const [attachments, app] = await Promise.allSettled([
      (deps.getAttachments ?? getJobAttachments)(jobId),
      (deps.getApplication ?? getLiveApplicationStatus)(jobId),
    ]);
    if (attachments.status === 'fulfilled') { files = attachments.value ?? []; attachmentState = 'verified'; }
    else { files = []; attachmentState = resourceError(attachments.reason); }
    application = app.status === 'fulfilled' ? app.value : resourceError(app.reason);
    db.prepare('INSERT INTO job_packets(job_id,payload,fetched_at) VALUES(?,?,?) ON CONFLICT(job_id) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at')
      .run(jobId, JSON.stringify({ detail, files, application }), fetchedAt);
  }
  const syncedAt = metadata(db, 'syncedAt');
  const eligibility = db.prepare('SELECT eligible,closed,reasons,checked_at FROM eligibility WHERE job_id=?').get(jobId);
  const rounds = getRecruitmentRounds(db, jobId);
  const cachedApplication = getApplicationStatus(db, jobId);
  const listedFiles = files.map(file => fileSummary(file, fetchedAt));
  let documentRecords = savedFiles;
  if (mode === 'live' && includeDocuments && attachmentState === 'verified' && files.length && detail) {
    const results = await (deps.download ?? downloadJobDescription)(db, jobId, { files, continueOnError: true });
    const refreshed = cachedDocuments(db, jobId);
    documentRecords = [...refreshed, ...results.filter(result => result.error).map(result => ({ id: result.fileId, error: result.error }))];
  }
  const documents = attachmentState === 'verified'
    ? await documentResults(listedFiles, documentRecords, includeDocuments, maxExcerptChars)
    : { state: attachmentState.state, code: attachmentState.code, files: [] };
  const base = cached?.job ?? {};
  const sourceName = mode === 'live' ? 'jobs_posted' : snapshot ? 'job packet cache' : 'job bundle cache';
  const missing = [];
  if (!detail) missing.push('live_job_details');
  if (!eligibility) missing.push('eligibility');
  if (application?.state === 'not_cached') missing.push('application');
  if (attachmentState === 'not_cached') missing.push('attachments');
  return {
    jobId, state: mode === 'live' && !detail ? 'not_found_live' : cached?.present === false ? 'removed_from_latest_bundle' : detail || cached ? 'found' : 'not_found',
    identity: { title: detail?.title ?? base.title ?? null, company: detail?.companies?.name ?? base.company ?? null,
      role: detail?.job_type ?? base.jobType ?? null, location: detail?.location ?? base.location ?? null },
    description: excerpt(detail?.description, 1800),
    requirements: excerpt(detail?.skills_required, 1200),
    selectionProcess: excerpt(detail?.selection_process, 800),
    compensation: (base.salaryOptions ?? []).slice(0, 10).map(value => ({ currency: value.currency ?? null,
      salaryType: value.salary_type ?? null, ctc: value.ctc ?? null, minCtc: value.min_ctc ?? null,
      maxCtc: value.max_ctc ?? null, stipend: value.stipend ?? null })),
    applicationDeadline: base.applicationDeadline ?? null,
    eligibilityRules: (base.eligibilityRules ?? []).slice(0, 10).map(value => ({ courseId: value.course_id ?? null,
      eligibleYears: value.eligible_years ?? null, eligibleBatches: value.eligible_batches ?? null,
      eligibleBranches: value.eligible_branches ?? null })),
    eligibility: eligibility ? { state: 'checked', eligible: Boolean(eligibility.eligible), closed: Boolean(eligibility.closed),
      reasons: JSON.parse(eligibility.reasons).slice(0, 10).map(reason => String(reason).slice(0, 200)), source: 'batch_check_job_eligibility_cached', checkedAt: eligibility.checked_at }
      : { state: 'not_cached' },
    application, rounds: { state: cachedApplication ? rounds.rounds.length ? 'reported' : 'none_reported' : 'no_application_in_snapshot',
      rounds: rounds.rounds.slice(0, 10), source: 'application bundle cache', snapshotAt: syncedAt },
    documents,
    freshness: { requested: freshness, actual: mode, policy: freshness === 'auto' ? 'packet snapshot <=15 minutes; documents cached if requested' : null,
      detailFetchedAt: fetchedAt, bundleSyncedAt: syncedAt, jobLastSeen: cached?.lastSeen ?? null,
      eligibilityCheckedAt: eligibility?.checked_at ?? null, cachedRecordPresent: cached?.present ?? null, removedAt: cached?.removedAt ?? null },
    sources: { job: sourceName, jobId, detail: detail ? mode === 'live' ? 'jobs_posted live' : 'job packet cache' : 'missing',
      compensation: 'get_student_job_bundle_page cache', applicationDeadline: 'get_student_job_bundle_page cache',
      eligibilityRules: 'get_student_job_bundle_page cache', application: application?.source ?? 'unavailable',
      rounds: 'application bundle cache', attachments: attachmentState === 'verified' ? mode === 'live' ? 'job_jd_files live' : 'job packet cache' : attachmentState.state ?? attachmentState,
      documentContent: 'local SHA-256 cache' },
    missing,
  };
}
