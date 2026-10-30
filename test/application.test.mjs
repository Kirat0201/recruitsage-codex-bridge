import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store.mjs';
import { prepareJobApplication, submitJobApplication } from '../src/application.mjs';

test('application requires exact approval, submits once, and verifies the portal row', async () => {
  const dir=mkdtempSync(path.join(os.tmpdir(),'rs-application-')), db=openStore(path.join(dir,'db.sqlite'));
  const jobId='11111111-1111-4111-8111-111111111111', resumeId='22222222-2222-4222-8222-222222222222', intentId='33333333-3333-4333-8333-333333333333';
  let applied=false, invokes=0;
  const services={
    now:()=>Date.parse('2026-10-30T10:00:00Z'), id:()=>intentId,
    profile:async()=>({id:'student',email:'student@example.edu',primary_resume_id:resumeId,resumes:[{id:resumeId,name:'Cloud Resume',filePath:`resumes/user/${resumeId}.pdf`,uploadDate:'2026-10-30T00:00:00Z'}]}),
    detail:async()=>({screening_questions:[{id:'why',question:'Why this role?',required:true,type:'text'}]}),
    eligibility:async()=>({eligible:true,reasons:[]}),
    application:async()=>applied?{state:'record',id:'application-1',status:'Applied',verifiedAt:'2026-10-30T10:01:00Z'}:{state:'no_record'},
    invoke:async(name,body)=>{invokes++; assert.equal(name,'submit-job-application'); assert.equal(body.resumeId,resumeId); assert.deepEqual(body.screeningAnswers,[{question_id:'why',value:'Relevant systems work'}]); applied=true; return{success:true,applicationId:'application-1'};},
  };
  try {
    db.prepare('INSERT INTO jobs(id,payload,first_seen,last_seen,changed_at) VALUES(?,?,?,?,?)').run(jobId,JSON.stringify({id:jobId,company:'Example',title:'Cloud Engineer',allowsApplications:true,applicationDeadline:'2026-10-31T09:00:00+05:30'}),'2026-10-30T00:00:00Z','2026-10-30T00:00:00Z','2026-10-30T00:00:00Z');
    const missing=await prepareJobApplication(db,{jobId},services); assert.equal(missing.state,'needs_answers');
    const ready=await prepareJobApplication(db,{jobId,screeningAnswers:[{questionId:'why',answer:'Relevant systems work'}]},services);
    assert.equal(ready.state,'awaiting_approval'); assert.equal(invokes,0);
    await assert.rejects(submitJobApplication(db,{intentId,confirmation:'yes'},services),/Exact per-job approval/); assert.equal(invokes,0);
    const result=await submitJobApplication(db,{intentId,confirmation:ready.approvalText},services);
    assert.equal(result.state,'submitted'); assert.equal(result.applicationId,'application-1'); assert.equal(invokes,1);
    const repeat=await submitJobApplication(db,{intentId,confirmation:ready.approvalText},services); assert.equal(repeat.state,'submitted'); assert.equal(invokes,1);
  } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});

test('unknown submission outcome is never retried or called successful', async () => {
  const dir=mkdtempSync(path.join(os.tmpdir(),'rs-application-')), db=openStore(path.join(dir,'db.sqlite'));
  const jobId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', resumeId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', intentId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  let invokes=0;
  const services={now:()=>Date.parse('2026-10-30T10:00:00Z'),id:()=>intentId,profile:async()=>({email:'student@example.edu',primary_resume_id:resumeId,resumes:[{id:resumeId,name:'Resume',filePath:`resumes/user/${resumeId}.pdf`}]}),detail:async()=>({screening_questions:[]}),eligibility:async()=>({eligible:true,reasons:[]}),application:async()=>({state:'no_record'}),invoke:async()=>{invokes++;const e=Error('unknown');e.code='SUBMISSION_UNKNOWN';throw e;}};
  try {db.prepare('INSERT INTO jobs(id,payload,first_seen,last_seen,changed_at) VALUES(?,?,?,?,?)').run(jobId,JSON.stringify({id:jobId,company:'Example',title:'Analyst',allowsApplications:true}),'2026-10-30T00:00:00Z','2026-10-30T00:00:00Z','2026-10-30T00:00:00Z');const ready=await prepareJobApplication(db,{jobId},services);const result=await submitJobApplication(db,{intentId,confirmation:ready.approvalText},services);assert.equal(result.state,'confirmation_pending');assert.equal(invokes,1);} finally {db.close();rmSync(dir,{recursive:true,force:true});}
});
