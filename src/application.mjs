import { randomUUID } from 'node:crypto';
import { authManager } from './auth.mjs';
import { invokeEdgeFunction, rpc, table, ApiError } from './http.mjs';
import { getJobDetails, getLiveApplicationStatus } from './jobs.mjs';
import { jobRecord } from './store.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function initApplications(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS application_intents (
    intent_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, portal_resume_id TEXT,
    payload TEXT NOT NULL, approval_text TEXT NOT NULL, state TEXT NOT NULL,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL, submitted_at TEXT, result TEXT
  );
  CREATE INDEX IF NOT EXISTS application_intents_job ON application_intents(job_id,created_at);`);
}

function tokenEmail(accessToken) {
  try {
    const email = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url')).email;
    if (typeof email === 'string' && email.includes('@')) return email.toLowerCase();
  } catch { /* handled below */ }
  throw new ApiError('INVALID_TOKEN', 'RecruitSage session lacks a readable email claim');
}

function normalizedResumes(value) {
  let resumes = value;
  if (typeof resumes === 'string') { try { resumes = JSON.parse(resumes); } catch { resumes = []; } }
  return Array.isArray(resumes) ? resumes.filter(item => item && uuid.test(item.id) && typeof item.filePath === 'string' && item.filePath.startsWith('resumes/') && !item.filePath.includes('..') && !/[\\?#]/.test(item.filePath)) : [];
}

async function loadPortalProfile() {
  const { accessToken } = await authManager.valid();
  const email = tokenEmail(accessToken);
  const rows = await table('students', { select: 'id,email,resumes,primary_resume_id,resume_url', email: `eq.${email}`, limit: 2 });
  if (!Array.isArray(rows) || rows.length !== 1) throw new ApiError('STUDENT_PROFILE', 'RecruitSage student profile could not be resolved uniquely');
  return { ...rows[0], email, resumes: normalizedResumes(rows[0].resumes) };
}

async function liveEligibility(jobId, email) {
  const result = await rpc('check_comprehensive_eligibility', { p_student_email: email, p_job_id: jobId });
  if (!result || typeof result.eligible !== 'boolean') throw new ApiError('ELIGIBILITY_SCHEMA', 'RecruitSage returned invalid live eligibility');
  return { eligible: result.eligible, reasons: Array.isArray(result.reasons) ? result.reasons.map(String).slice(0, 10) : [] };
}

export function questions(detail) {
  const rows = Array.isArray(detail?.screening_questions) ? detail.screening_questions : detail?.screening_questions?.questions ?? [];
  return rows.slice(0, 20).map(item => ({ id: String(item.id ?? item.question_id ?? ''), question: String(item.question ?? item.text ?? item.label ?? '').slice(0, 500), required: item.required !== false, type: String(item.type ?? 'text').slice(0, 40), options: Array.isArray(item.options) ? item.options.map(String).slice(0, 20) : [] })).filter(item => item.id && item.question);
}

function validateAnswers(requiredQuestions, supplied = []) {
  const clean = answer => typeof answer === 'string' ? answer.slice(0, 3000) : Array.isArray(answer) ? answer.map(String).slice(0, 30).map(item => item.slice(0, 500)) : typeof answer === 'boolean' || typeof answer === 'number' ? answer : null;
  const answers = supplied.map(item => ({ question_id: String(item.questionId ?? item.question_id ?? '').slice(0, 100), value: clean(item.value ?? item.answer) })).filter(item => item.question_id && item.value !== null);
  const byId = new Map(answers.map(item => [item.question_id, item]));
  const missing = requiredQuestions.filter(item => {
    const value = byId.get(item.id)?.value;
    return item.required && (value == null || value === '' || (Array.isArray(value) && !value.length) || ['file','video'].includes(item.type) || (item.type === 'select' && !item.options.includes(value)) || (item.type === 'multiselect' && (!Array.isArray(value) || value.some(v => !item.options.includes(v)))));
  }).map(item => item.id);
  return { answers: answers.slice(0, 20), missing };
}

const defaults = { profile: loadPortalProfile, eligibility: liveEligibility, detail: getJobDetails, application: getLiveApplicationStatus, invoke: invokeEdgeFunction, now: () => Date.now(), id: randomUUID };

async function verifyPortalApplication(service, jobId, attempts = 4) {
  for (let index = 0; index < attempts; index++) {
    const result = await service(jobId).catch(() => null);
    if (result?.state === 'record') return result;
    if (index + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 250));
  }
  return null;
}

export async function prepareJobApplication(db, { jobId, portalResumeId, screeningAnswers = [] } = {}, supplied = {}) {
  initApplications(db);
  const services = { ...defaults, ...supplied };
  const record = jobRecord(db, jobId);
  if (!record || !record.present) throw new ApiError('UNKNOWN_JOB', 'Job is not active in the local RecruitSage cache');
  const [profile, detail, existing] = await Promise.all([services.profile(), services.detail(jobId), services.application(jobId)]);
  if (existing?.state === 'record') return { state: 'already_applied', jobId, application: existing };
  const eligibility = await services.eligibility(jobId, profile.email);
  if (!eligibility.eligible) return { state: 'blocked', reason: 'not_eligible', jobId, eligibility };
  if (record.job.allowsApplications === false) return { state: 'blocked', reason: 'applications_disabled', jobId };
  const deadline = record.job.applicationDeadline;
  if (deadline && /(?:Z|[+-]\d\d:?\d\d)$/.test(deadline) && Date.parse(deadline) <= services.now()) return { state: 'blocked', reason: 'deadline_passed', jobId, deadline };
  const portalResumes = profile.resumes;
  const selected = portalResumeId ? portalResumes.find(item => item.id === portalResumeId) : portalResumes.find(item => item.id === profile.primary_resume_id) ?? portalResumes.at(-1);
  if (!selected) return { state: 'blocked', reason: 'portal_resume_required', jobId, portalResumes: portalResumes.map(item => ({ id: item.id, name: item.name ?? 'Resume', uploadDate: item.uploadDate ?? null })) };
  const screeningQuestions = questions(detail);
  const checked = validateAnswers(screeningQuestions, screeningAnswers);
  if (checked.missing.length) return { state: 'needs_answers', jobId, screeningQuestions, missingQuestionIds: checked.missing, selectedPortalResume: { id: selected.id, name: selected.name ?? 'Resume', uploadDate: selected.uploadDate ?? null } };
  const intentId = services.id();
  const approvalText = `APPLY ${record.job.company} — ${record.job.title} [${jobId}]`;
  const createdAt = new Date(services.now()).toISOString(), expiresAt = new Date(services.now() + 30 * 60_000).toISOString();
  const payload = { jobId, studentEmail: profile.email, portalResume: { id: selected.id, name: selected.name ?? 'Resume', filePath: selected.filePath, uploadDate: selected.uploadDate ?? null }, screeningAnswers: checked.answers, eligibility, jobSnapshotAt: record.lastSeen, deadline };
  db.prepare('INSERT INTO application_intents VALUES(?,?,?,?,?,?,?,?,?,?)').run(intentId, jobId, selected.id, JSON.stringify(payload), approvalText, 'awaiting_approval', createdAt, expiresAt, null, null);
  return { state: 'awaiting_approval', intentId, expiresAt, job: { id: jobId, company: record.job.company, title: record.job.title, deadline }, selectedPortalResume: { id: selected.id, name: selected.name ?? 'Resume', uploadDate: selected.uploadDate ?? null }, screeningAnswers: checked.answers, approvalText, warning: 'Submission changes RecruitSage. Send the exact approval text only after reviewing the job, portal resume and answers.' };
}

export async function submitJobApplication(db, { intentId, confirmation } = {}, supplied = {}) {
  initApplications(db);
  const services = { ...defaults, ...supplied };
  const row = db.prepare('SELECT * FROM application_intents WHERE intent_id=?').get(intentId);
  if (!row) throw new ApiError('INTENT_NOT_FOUND', 'Application intent not found');
  if (row.state !== 'awaiting_approval') return { state: row.state, intentId, result: row.result ? JSON.parse(row.result) : null };
  if (services.now() > Date.parse(row.expires_at)) {
    db.prepare("UPDATE application_intents SET state='expired' WHERE intent_id=?").run(intentId);
    return { state: 'expired', intentId, nextAction: 'Prepare a fresh application intent' };
  }
  if (confirmation !== row.approval_text) throw new ApiError('APPROVAL_REQUIRED', 'Exact per-job approval text is required');
  const payload = JSON.parse(row.payload);
  const [profile, existing] = await Promise.all([services.profile(), services.application(row.job_id)]);
  if (existing?.state === 'record') {
    const result = { state: 'already_applied', jobId: row.job_id, application: existing };
    db.prepare("UPDATE application_intents SET state='already_applied',submitted_at=?,result=? WHERE intent_id=?").run(new Date(services.now()).toISOString(), JSON.stringify(result), intentId);
    return result;
  }
  const eligibility = await services.eligibility(row.job_id, profile.email);
  if (!eligibility.eligible) throw new ApiError('NOT_ELIGIBLE', 'Fresh RecruitSage eligibility check rejected this application');
  const selected = profile.resumes.find(item => item.id === row.portal_resume_id && item.filePath === payload.portalResume.filePath);
  if (!selected) throw new ApiError('RESUME_CHANGED', 'Approved portal resume is no longer available; prepare again');
  if (profile.email !== payload.studentEmail) throw new ApiError('ACCOUNT_CHANGED', 'Application belongs to a different account');
  const detail = await services.detail(row.job_id);
  const currentAnswers = validateAnswers(questions(detail), payload.screeningAnswers);
  if (currentAnswers.missing.length) throw new ApiError('QUESTIONS_CHANGED', 'Required questions changed; prepare this application again');
  const claimed = db.prepare("UPDATE application_intents SET state='submitting' WHERE intent_id=? AND state='awaiting_approval'").run(intentId);
  if (!claimed.changes) return {state:'submitting',intentId};
  let response;
  try {
    response = await services.invoke('submit-job-application', { jobId: row.job_id, studentEmail: profile.email, resumeUrl: '', screeningAnswers: payload.screeningAnswers.length ? payload.screeningAnswers : undefined, resumeId: selected.id, resumeFilePath: selected.filePath, resumeSelectionVersion: 1 });
  } catch (error) {
    const verified = await services.application(row.job_id).catch(() => null);
    if (verified?.state === 'record') response = { success: true, applicationId: verified.id ?? null, recoveredAfterError: true };
    else {
      const result = { state: error.code === 'SUBMISSION_UNKNOWN' ? 'confirmation_pending' : 'rejected', jobId: row.job_id, code: error.code ?? 'APPLICATION_FAILED', message: error.message, reasons: error.reasons ?? [] };
      db.prepare('UPDATE application_intents SET state=?,submitted_at=?,result=? WHERE intent_id=?').run(result.state, new Date(services.now()).toISOString(), JSON.stringify(result), intentId);
      return result;
    }
  }
  const verified = await verifyPortalApplication(services.application, row.job_id);
  const success = response?.success === true && verified?.state === 'record';
  const result = success ? { state: 'submitted', jobId: row.job_id, applicationId: verified.id ?? response.applicationId ?? null, portalStatus: verified.status ?? null, verifiedAt: verified.verifiedAt ?? new Date(services.now()).toISOString(), selectedPortalResume: { id: selected.id, name: selected.name ?? 'Resume' } }
    : { state: 'confirmation_pending', jobId: row.job_id, message: 'RecruitSage responded, but no application row is visible yet. Check My Applications before retrying.' };
  db.prepare('UPDATE application_intents SET state=?,submitted_at=?,result=? WHERE intent_id=?').run(result.state, new Date(services.now()).toISOString(), JSON.stringify(result), intentId);
  return result;
}
