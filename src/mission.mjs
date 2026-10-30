import { cachedJob, jobRecord } from './store.mjs';
import { careerBriefing } from './career-context.mjs';
import { getJobPacket } from './job-packet.mjs';
import { getProjectMemory } from './project-memory.mjs';
import { getResumeSource } from './resume-source.mjs';

function init(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS job_missions (
    job_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, status TEXT NOT NULL,
    selected_resume_id TEXT, evidence TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );`);
}

function teachingPlan(job, packet, history) {
  const title = job.title ?? '';
  const topics = [];
  if (/robotic/i.test(title)) topics.push('robotics systems and field debugging');
  if (/data infrastructure/i.test(title)) topics.push('data pipelines, reliability and observability');
  if (/forward deployed/i.test(title)) topics.push('customer discovery, integration and incident response');
  if (/cloud/i.test(title)) topics.push('cloud fundamentals, deployment and operational tradeoffs');
  if (!topics.length) topics.push('role fundamentals and project defense');
  const weak = history.filter(item => item.score < 4).map(item => item.followUp ?? item.feedback).filter(Boolean).slice(0,2);
  const day = job.applicationDeadline?.slice(0, 10);
  const daysLeft = day ? Math.ceil((Date.parse(`${day}T00:00:00Z`) - Date.now()) / 86_400_000) : null;
  const priority = daysLeft !== null && daysLeft <= 1 ? 'urgent' : weak.length ? 'high' : 'normal';
  return { basis: packet.requirements?.text && packet.requirements.text !== '[]' ? 'job_description' : 'title_inference_needs_JD_review',
    topics, revisit: weak, priority, suggestedSessionMinutes: priority === 'urgent' ? 25 : 45,
    nextPractice: weak[0] ?? `Explain one real project that relates to ${title}; state your contribution, decisions and test evidence.` };
}

function reviewResume(db, resume, job, projectMemory, editableSource) {
  if (!resume) return { state: 'missing', decisions: [] };
  const text = db.prepare('SELECT extracted FROM resumes WHERE id=?').get(resume.resumeId)?.extracted ?? '';
  const decisions = [];
  if (/robotic|data infrastructure|forward deployed/i.test(job.title ?? '')) {
    if (/SSHSentry/i.test(text)) decisions.push({ item: 'SSHSentry', decision: 'keep', reason: 'Shows log parsing, incident signals and operational debugging in the actual resume.' });
    if (/AI-SQL-Analyst/i.test(text)) decisions.push({ item: 'AI-SQL-Analyst', decision: 'keep_with_focus', reason: 'Shows database and API work; explain reliability and query safety rather than claiming robotics experience.' });
    if (/Canvas\.io/i.test(text)) decisions.push({ item: 'Canvas.io', decision: 'remove_for_this_role', reason: 'Interactive whiteboard features are weaker evidence for robotics field work or data infrastructure.' });
    if (/crumbles\.dev/i.test(text)) decisions.push({ item: 'crumbles.dev internship', decision: 'lead_with', reason: 'Incident response, service integration and follow-up workflows are the strongest role-adjacent experience.' });
    if (/\bDocker\b/i.test(text) && !/PROJECTS[\s\S]*\bDocker\b/i.test(text)) decisions.push({ item: 'Docker skill', decision: 'verify_before_emphasizing', reason: 'Listed in skills, but no project bullet states what was containerized or tested.' });
  }
  for (const project of projectMemory.projects.slice(0, 3)) {
    const alreadyNamed = new RegExp(project.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text);
    decisions.push({ item: project.name, decision: alreadyNamed ? 'defend_with_evidence' : project.assessment.state === 'resume_ready' ? 'candidate_for_resume' : 'strengthen_before_resume',
      reason: alreadyNamed ? `Project is already on the resume; prepare proof from ${project.evidenceRefs[0] ?? project.projectPath}.` : project.assessment.state === 'resume_ready'
        ? `Strong local evidence and estimated role match (${project.match.score}%); consider it if it displaces a weaker project.`
        : `Potential role match, but first add: ${project.assessment.missingEvidence.slice(0,2).join('; ')}.` });
  }
  return { state: 'evidence_review', source: `resume:${resume.evidence.resumeHash}`, projectEvidenceSource: projectMemory.source, editableSource, decisions,
    layoutStatus: editableSource.state === 'current' ? `Editable ${editableSource.sourceKind} source is tracked and current; preserve its layout when tailoring.`
      : editableSource.state === 'changed_since_registration' ? 'Editable source changed since registration; review it before generating the next PDF.'
      : 'No current editable source is available for format-preserving tailoring.', claimPolicy: 'Do not add robotics or deployment experience without a real project example.' };
}

export async function prepareJobMission(db, { accountId, jobId, freshness = 'live' } = {}) {
  init(db);
  const record = jobRecord(db, jobId);
  if (!record) throw Error('Job must be present in the local RecruitSage cache');
  const packet = await getJobPacket(db, { jobId, freshness, includeDocuments: true });
  const briefing = careerBriefing(db, { accountId, jobId });
  const current = db.prepare('SELECT * FROM job_missions WHERE job_id=?').get(jobId);
  const resume = briefing.bestResume;
  const eligibility = packet.eligibility;
  const applied = packet.application?.state === 'record' || Boolean(cachedJob(db, jobId)?.applied);
  const deadline = record.job.applicationDeadline;
  const status = applied ? 'already_applied' : !record.present || eligibility.closed ? 'closed'
    : eligibility.state !== 'checked' || !eligibility.eligible ? 'eligibility_review'
    : !resume ? 'resume_required' : 'preparation_required';
  const concerns = [];
  if (!packet.requirements?.text || packet.requirements.text === '[]') concerns.push('No explicit JD requirements available; title-based preparation is an estimate.');
  if (resume && !new RegExp(record.job.company?.split(' ')[0] ?? '', 'i').test(resume.label)) concerns.push(`Available resume is labeled "${resume.label}"; review and tailor a copy before applying.`);
  if (deadline && !/(?:Z|[+-]\d\d:?\d\d)$/.test(deadline)) concerns.push('Portal deadline has no timezone; verify its exact cutoff.');
  const packetRow = db.prepare('SELECT payload FROM job_packets WHERE job_id=?').get(jobId);
  const externalRoleLinks = packetRow ? JSON.parse(packetRow.payload).detail?.company_links ?? [] : [];
  const evidence = { jobSnapshotAt: record.lastSeen, detailFetchedAt: packet.freshness?.detailFetchedAt,
    eligibilityCheckedAt: eligibility.checkedAt ?? null, applicationVerifiedAt: packet.application?.verifiedAt ?? null,
    resumeHash: resume?.evidence?.resumeHash ?? null, deadline, concerns,
    externalRoleLinks: externalRoleLinks.slice(0, 5).map(link => ({ label: link.label, url: link.url, basis: 'company_link_not_portal_JD' })) };
  const teaching = teachingPlan(record.job, packet, briefing.interviewHistory);
  const projectMemory = getProjectMemory(db, { jobId, limit: 5 });
  const editableSource = resume ? await getResumeSource(db, { resumeId: resume.resumeId }) : { state: 'not_tracked' };
  const resumeReview = reviewResume(db, resume, record.job, projectMemory, editableSource);
  evidence.teaching = teaching;
  evidence.resumeReview = resumeReview;
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO job_missions(job_id,account_id,status,selected_resume_id,evidence,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET account_id=excluded.account_id,status=excluded.status,
    selected_resume_id=excluded.selected_resume_id,evidence=excluded.evidence,updated_at=excluded.updated_at`)
    .run(jobId, accountId, status, resume?.resumeId ?? null, JSON.stringify(evidence), current?.created_at ?? now, now);
  return { jobId, company: record.job.company, title: record.job.title, roleType: record.job.jobType,
    status, deadline, eligibility, application: packet.application, selectedResume: resume ? { id: resume.resumeId, label: resume.label, hash: resume.evidence.resumeHash } : null,
    evidence, teaching, resumeReview, projectMemory,
    nextAction: applied ? 'Prepare for the next verified round' : status === 'preparation_required'
      ? 'Review resume claims and portal requirements before submission' : 'Resolve the stated mission status before applying' };
}

export function getJobMission(db, jobId) {
  init(db);
  const row = db.prepare('SELECT * FROM job_missions WHERE job_id=?').get(jobId);
  return row ? { jobId, accountId: row.account_id, status: row.status, selectedResumeId: row.selected_resume_id,
    evidence: JSON.parse(row.evidence), createdAt: row.created_at, updatedAt: row.updated_at } : null;
}
