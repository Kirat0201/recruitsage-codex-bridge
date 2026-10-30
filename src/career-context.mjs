import { syncJobs } from './jobs.mjs';
import { getPlacementDocket, syncGmail } from './gmail-sync.mjs';
import { jobRecord } from './store.mjs';
import { initIntelligence, matchResume, startSensei } from './intelligence.mjs';
import { initGmailStore } from './gmail-store.mjs';

function init(db) { initGmailStore(db); initIntelligence(db); db.exec(`CREATE TABLE IF NOT EXISTS career_actions (
  action_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, job_id TEXT NOT NULL, kind TEXT NOT NULL,
  due_at TEXT, state TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS career_actions_account_due ON career_actions(account_id,state,due_at);
  CREATE TABLE IF NOT EXISTS career_sync_state (account_id TEXT PRIMARY KEY, job_synced_at TEXT, gmail_history_id TEXT, completed_at TEXT);`);
  const columns=new Set(db.prepare('PRAGMA table_info(career_sync_state)').all().map(row=>row.name));
  if(!columns.has('failed_at')) db.exec('ALTER TABLE career_sync_state ADD COLUMN failed_at TEXT');
  if(!columns.has('error_code')) db.exec('ALTER TABLE career_sync_state ADD COLUMN error_code TEXT'); }
function upsertAction(db, accountId, jobId, kind, dueAt, source, title, state='pending') {
  if (dueAt && Date.parse(dueAt) < Date.now() - 86_400_000) state='historical';
  if (!dueAt && source.localDate && source.localDate < new Date().toISOString().slice(0,10)) state='historical';
  if (state === 'pending' && source.needsReview) state = 'needs_review';
  const id = `${accountId}:${jobId}:${kind}:${source.localDate ?? dueAt ?? source.id}:${dueAt ?? 'date_only'}`;
  const payload = { actionId:id, jobId, kind, dueAt, title, source, state };
  db.prepare(`INSERT INTO career_actions(action_id,account_id,job_id,kind,due_at,state,payload,updated_at)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(action_id) DO UPDATE SET due_at=excluded.due_at,state=excluded.state,payload=excluded.payload,updated_at=excluded.updated_at`)
    .run(id, accountId, jobId, kind, dueAt, state, JSON.stringify(payload), new Date().toISOString());
}
export function rebuildCareerActions(db, accountId) {
  init(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM career_actions WHERE account_id=?').run(accountId);
    const events=db.prepare('SELECT job_id,payload,source_ref,created_at FROM docket_events WHERE account_id=?').all(accountId)
      .sort((a,b)=>String(JSON.parse(a.payload).publishedAt??a.created_at).localeCompare(String(JSON.parse(b.payload).publishedAt??b.created_at)) || a.source_ref.localeCompare(b.source_ref));
    for (const row of events) {
      const event = JSON.parse(row.payload);
      if (!event.dueAt && !event.localDate && !event.needsReview) continue;
      if(event.reschedule){
        const old=db.prepare("SELECT action_id,payload FROM career_actions WHERE account_id=? AND job_id=? AND kind=? AND state IN ('pending','needs_review')").all(accountId,row.job_id,event.type);
        for(const prior of old){const payload=JSON.parse(prior.payload);if(payload.source?.id===event.id)continue;payload.state='superseded';payload.supersededBy=event.id;db.prepare("UPDATE career_actions SET state='superseded',payload=?,updated_at=? WHERE action_id=?").run(JSON.stringify(payload),new Date().toISOString(),prior.action_id);}
      }
      upsertAction(db,accountId,row.job_id,event.type,event.dueAt,{id:event.id,ref:row.source_ref,quote:event.evidence?.quote??null,localDate:event.localDate,precision:event.precision,reschedule:event.reschedule,needsReview:event.needsReview,reviewReason:event.reviewReason},event.title);
    }
    const seenSelections=new Set();
    for (const row of db.prepare('SELECT payload FROM selection_events WHERE account_id=?').all(accountId)) {
      const event = JSON.parse(row.payload);
      if (event.outcome !== 'shortlisted') continue;
      const key=[event.jobId,event.stage].join(':');
      if(seenSelections.has(key))continue;
      seenSelections.add(key);
      upsertAction(db,accountId,event.jobId,'interview_preparation',null,{id:event.eventId,ref:event.sourceRef},`Prepare for ${event.stage} at ${event.company}`);
    }
    db.exec('COMMIT');
  } catch(error) { db.exec('ROLLBACK'); throw error; }
  return db.prepare("SELECT COUNT(*) AS n FROM career_actions WHERE account_id=? AND state IN ('pending','needs_review')").get(accountId).n;
}
export function careerBriefing(db,{accountId,jobId,limit=10}={}) {
  init(db);
  const actions=db.prepare("SELECT payload FROM career_actions WHERE account_id=? AND state IN ('pending','needs_review') ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,due_at LIMIT ?").all(accountId,Math.min(Math.max(limit,1),20)).map(r=>JSON.parse(r.payload));
  const state=db.prepare('SELECT * FROM career_sync_state WHERE account_id=?').get(accountId)??null;
  const job=jobId?jobRecord(db,jobId):null;
  const comparison=job?matchResume(db,{jobId}):null;
  const history=jobId?db.prepare("SELECT t.content,t.created_at FROM sensei_turns t JOIN sensei_sessions s ON s.id=t.session_id WHERE s.job_id=? AND t.role='feedback' ORDER BY t.id DESC LIMIT 5").all(jobId).map(r=>({at:r.created_at,...JSON.parse(r.content)})):[];
  const packetRow=jobId?db.prepare('SELECT payload,fetched_at FROM job_packets WHERE job_id=?').get(jobId):null;
  const detail=packetRow?JSON.parse(packetRow.payload).detail:null;
  const jd=job?{description:String(detail?.description??job.job.description??'').slice(0,1800),requirements:String(detail?.skills_required??job.job.requirements??'').slice(0,1200),source:detail?'job packet cache':'job bundle cache',snapshotAt:packetRow?.fetched_at??job.lastSeen}:null;
  const resumes=comparison?.resumes?.slice(0,3).map(r=>({resumeId:r.resumeId,label:r.label,fitPercent:r.fitPercent,fitMethod:r.fitPercent===null?'unavailable':'keyword_overlap_estimate',matched:r.matchedSkills?.slice(0,12),gaps:r.gaps?.slice(0,12),profile:Object.fromEntries(Object.entries(r.profile??{}).map(([k,v])=>[k,v.slice(0,2).map(x=>({text:x.text.slice(0,240),source:x.source}))])),evidence:r.evidence}))??[];
  return {source:'local SQLite',accountId,sync:state,job:job?{id:jobId,company:job.job.company,title:job.job.title,snapshotAt:job.lastSeen,jd}:null,
    eligibility:comparison?.resumes?.[0]?.eligibility??null,bestResume:resumes[0]??null,fitExplanation:resumes[0]?.fitPercent===null?comparison?.limitation:resumes[0]?`Keyword overlap estimate: matched ${resumes[0].matched.length} terms; ${resumes[0].gaps.length} unmatched terms shown. Check JD and resume evidence before claiming experience.`:null,resumes,actions,interviewHistory:history};
}
export function prepareCareerInterview(db,{accountId,jobId}={}) {
  init(db);
  const account=accountId??db.prepare('SELECT account_id FROM gmail_accounts ORDER BY account_id LIMIT 1').get()?.account_id;
  if (!account) throw Error('A configured Gmail account is required for the sourced briefing');
  const briefing=careerBriefing(db,{accountId:account,jobId});
  if (!briefing.job || !briefing.bestResume) return {state:'resume_or_job_missing',jobId,briefing};
  const prior=briefing.interviewHistory.find(item=>item.score<4 && item.followUp)??briefing.interviewHistory.find(item=>item.followUp);
  const dockerListed=briefing.bestResume.profile?.skills?.some(item=>/\bDocker\b/i.test(item.text));
  const question=prior?.followUp??(briefing.bestResume.matched[0]
    ? `For ${briefing.job.title} at ${briefing.job.company}, explain how you used ${briefing.bestResume.matched[0]} in a project on your resume. What did you build and how did you test it?`
    : dockerListed && /cloud/i.test(briefing.job.title)
    ? `For ${briefing.job.title} at ${briefing.job.company}, your resume lists Docker. Explain a project where you used it, your deployment choices, and how you checked the result. If you did not use it in a project, say so.`
    : `For ${briefing.job.title} at ${briefing.job.company}, explain a relevant project from your resume and the technical decisions you made.`);
  const session=startSensei(db,{jobId,resumeId:briefing.bestResume.resumeId,question});
  return {state:'ready',jobId,briefing,session,assistantInstruction:'Use only the sourced JD, resume, actions and prior feedback in this briefing. Ask the saved first question. After the user answers, call record_sensei_answer, assess the answer against the evidence, then call record_sensei_feedback with a score, specific feedback and one follow-up. Do not invent the user answer or experience.'};
}
export async function runCareerWorkflow(db,{accountId,live=true}={}) {
  init(db);
  try {
    const jobs=live?await syncJobs(db):null;
    const gmail=await syncGmail(db,{accountId,freshness:live?'live':'cache'});
    await getPlacementDocket(db,{accountId,freshness:'cache',limit:20});
    const actionCount=rebuildCareerActions(db,accountId);
    const at=new Date().toISOString();
    db.prepare('INSERT INTO career_sync_state(account_id,job_synced_at,gmail_history_id,completed_at,failed_at,error_code) VALUES(?,?,(SELECT history_id FROM gmail_accounts WHERE account_id=?),?,NULL,NULL) ON CONFLICT(account_id) DO UPDATE SET job_synced_at=excluded.job_synced_at,gmail_history_id=excluded.gmail_history_id,completed_at=excluded.completed_at,failed_at=NULL,error_code=NULL').run(accountId,jobs?.syncedAt??null,accountId,at);
    return {accountId,source:live?'live RecruitSage and Gmail API':'local SQLite',jobs:jobs?{stored:jobs.stored,added:jobs.added,changed:jobs.changed,removed:jobs.removed}:null,gmail:{mode:gmail.mode??'cache',messagesFetched:gmail.messagesFetched??0,apiCalls:gmail.gmailApiCalls},pendingActions:actionCount,completedAt:at};
  } catch(error) {
    db.prepare('INSERT INTO career_sync_state(account_id,failed_at,error_code) VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET failed_at=excluded.failed_at,error_code=excluded.error_code').run(accountId,new Date().toISOString(),String(error.code??'SYNC_FAILED').slice(0,80));
    throw error;
  }
}
