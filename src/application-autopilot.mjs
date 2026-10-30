import { prepareJobApplication, submitJobApplication } from './application.mjs';

export function initAutopilot(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS candidate_facts(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS application_queue(job_id TEXT PRIMARY KEY,portal_resume_id TEXT,state TEXT NOT NULL,answers TEXT NOT NULL,result TEXT,updated_at TEXT NOT NULL);`);
}
const normalize = text => text.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const fields = [
  ['current_city', /^(?:what is your )?(?:current city|city of residence|where do you currently live)\??$/i],
  ['full_name', /^(?:your |candidate |full )?name\??$/i],
  ['email', /^(?:your |candidate )?email(?: address| id)?\??$/i],
  ['phone', /^(?:your |candidate )?(?:phone|mobile|contact)(?: number)?\??$/i],
  ['hometown', /^(?:your )?(?:hometown|home town|permanent city)\??$/i],
  ['linkedin', /^(?:your )?linkedin(?: profile| url| link)?\??$/i],
  ['github', /^(?:your )?github(?: profile| url| link)?\??$/i],
];
export function saveCandidateFacts(db, {facts}) {
  initAutopilot(db);
  const save=db.prepare('INSERT INTO candidate_facts VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at');
  for(const fact of facts) {
    if(!fact.key || fact.key.length>500 || typeof fact.value!=='string' || !fact.value.trim() || fact.value.length>2000) throw Error('A fact needs a key and a nonempty value under 2000 characters');
    save.run(fact.key, fact.value.trim(),new Date().toISOString());
  }
  return {saved:facts.length};
}
export function applicationQueue(db) {
  initAutopilot(db);
  return {items:db.prepare('SELECT * FROM application_queue ORDER BY updated_at DESC LIMIT 30').all().map(r=>({jobId:r.job_id,state:r.state,result:r.result?JSON.parse(r.result):null,updatedAt:r.updated_at})), instruction:'Ask the user the missingQuestions verbatim. Save reusable facts only when the user supplies them; call run_application_autopilot with the jobId and answers to resume.'};
}
export async function runApplicationAutopilot(db,{jobId,portalResumeId,answers=[]}, services={}) {
  initAutopilot(db);
  const old=db.prepare('SELECT * FROM application_queue WHERE job_id=?').get(jobId);
  if(old && ['submitted','already_applied','confirmation_pending','processing'].includes(old.state)) return {jobId,state:old.state,result:old.result?JSON.parse(old.result):null};
  const merged=new Map([...(old?JSON.parse(old.answers):[]),...answers].map(a=>[a.questionId,a]));
  const now=new Date().toISOString();
  db.prepare(`INSERT INTO application_queue VALUES(?,?,'queued',?,NULL,?) ON CONFLICT(job_id) DO UPDATE SET answers=excluded.answers,portal_resume_id=COALESCE(excluded.portal_resume_id,portal_resume_id),state='queued',updated_at=excluded.updated_at WHERE application_queue.state NOT IN ('processing','submitted','already_applied','confirmation_pending')`).run(jobId,portalResumeId??null,JSON.stringify([...merged.values()]),now);
  const claim=db.prepare("UPDATE application_queue SET state='processing' WHERE job_id=? AND state='queued'").run(jobId);
  if(!claim.changes) return {state:'processing',jobId};
  const prepare=services.prepare??prepareJobApplication, submit=services.submit??submitJobApplication;
  try {
    const input={jobId,portalResumeId:portalResumeId??old?.portal_resume_id??undefined,screeningAnswers:[...merged.values()]};
    let result=await prepare(db,input);
    if(result.state==='needs_answers') {
      const facts=new Map(db.prepare('SELECT key,value FROM candidate_facts').all().map(r=>[r.key,r.value]));
      for(const q of result.screeningQuestions) {
        if(merged.has(q.id)) continue;
        const key=fields.find(([,pattern])=>pattern.test(q.question.trim()))?.[0];
        let value=facts.get(`question:${normalize(q.question)}`)??(key?facts.get(key):undefined);
        if(q.type==='select' && value) value=q.options.find(option=>normalize(option)===normalize(value));
        if(value && !['file','video','multiselect'].includes(q.type)) merged.set(q.id,{questionId:q.id,answer:value});
      }
      result=await prepare(db,{...input,screeningAnswers:[...merged.values()]});
      if(result.state==='needs_answers') result={...result,missingQuestions:result.screeningQuestions.filter(q=>result.missingQuestionIds.includes(q.id)).map(q=>({...q,factKey:fields.find(([,pattern])=>pattern.test(q.question.trim()))?.[0]??`question:${normalize(q.question)}`}))};
    }
    if(result.state==='awaiting_approval') result=await submit(db,{intentId:result.intentId,confirmation:result.approvalText});
    db.prepare('UPDATE application_queue SET state=?,answers=?,result=?,updated_at=? WHERE job_id=?').run(result.state,JSON.stringify([...merged.values()]),JSON.stringify(result),new Date().toISOString(),jobId);
    return result;
  } catch(error) {
    db.prepare("UPDATE application_queue SET state='error',result=?,updated_at=? WHERE job_id=?").run(JSON.stringify({code:error.code??'ERROR',message:error.message}),new Date().toISOString(),jobId);
    throw error;
  }
}
