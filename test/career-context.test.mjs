import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store.mjs';
import { extractActions } from '../src/gmail-sync.mjs';
import { rebuildCareerActions, careerBriefing, prepareCareerInterview } from '../src/career-context.mjs';
import { initGmailStore } from '../src/gmail-store.mjs';
import { answerSensei, recordSenseiFeedback } from '../src/intelligence.mjs';

test('IST reschedule supersedes earlier OA and survives SQLite restart', () => {
  const dir=mkdtempSync(path.join(os.tmpdir(),'rs-career-')), file=path.join(dir,'db.sqlite'), accountId='student@example.edu';
  let db=openStore(file); initGmailStore(db);
  const job={id:'11111111-1111-4111-8111-111111111111',company:'Example',title:'Analyst'};
  const messages=[
    {messageId:'old',bodyText:'Online assessment 30-Oct-26 at 7:00 PM IST.',internalDate:'2026-10-28T08:00:00Z'},
    {messageId:'new',bodyText:'Online assessment rescheduled to 31-Oct-26 at 8:00 PM IST.',internalDate:'2026-10-29T08:00:00Z'},
  ];
  try {
    for(const message of messages) for(const event of extractActions({...message,accountId,subject:'OA',sourceRef:`gmail:${accountId}/${message.messageId}`,fetchedAt:message.internalDate},job))
      db.prepare('INSERT INTO docket_events VALUES(?,?,?,?,?,?)').run(event.id,accountId,job.id,JSON.stringify(event),event.evidence.sourceRef,message.internalDate);
    assert.equal(rebuildCareerActions(db,accountId),1);
    db.close(); db=openStore(file);
    const result=careerBriefing(db,{accountId,jobId:job.id});
    assert.equal(result.actions.length,1);
    assert.equal(result.actions[0].dueAt,'2026-10-31T14:30:00.000Z');
    assert.equal(db.prepare("SELECT count(*) n FROM career_actions WHERE state='superseded'").get().n,1);
    assert.equal(rebuildCareerActions(db,accountId),1);
  } finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('duplicate notice, uncertain time, and prior Sensei gap stay grounded', () => {
  const dir=mkdtempSync(path.join(os.tmpdir(),'rs-sensei-')), file=path.join(dir,'db.sqlite'), accountId='student@example.edu';
  let db=openStore(file); initGmailStore(db);
  const job={id:'22222222-2222-4222-8222-222222222222',company:'Example',title:'Cloud Analyst'};
  const resumeId='33333333-3333-4333-8333-333333333333';
  const notice=(messageId,bodyText,internalDate)=>({accountId,messageId,subject:'Cloud Analyst OA',bodyText,internalDate,fetchedAt:internalDate,sourceRef:`gmail:${accountId}/${messageId}`});
  try {
    db.prepare('INSERT INTO jobs(id,payload,first_seen,last_seen,changed_at) VALUES(?,?,?,?,?)').run(job.id,JSON.stringify(job),'2026-10-29T00:00:00Z','2026-10-29T00:00:00Z','2026-10-29T00:00:00Z');
    db.exec('CREATE TABLE resumes(id TEXT PRIMARY KEY,label TEXT,path TEXT,sha256 TEXT,extracted TEXT,created_at TEXT)');
    db.prepare('INSERT INTO resumes VALUES(?,?,?,?,?,?)').run(resumeId,'Cloud resume','fixture.pdf','fixture','PROJECTS\nCloud deployment with Docker and Python.','2026-10-29T00:00:00Z');
    db.prepare('INSERT INTO gmail_accounts VALUES(?,?,?,?,?,?,?)').run(accountId,'subject:Example','["Example"]','[]',null,null,'2026-10-29T00:00:00Z');
    for(const message of [
      notice('a','Online assessment 31-Oct-26 at 8:00 PM IST.','2026-10-29T07:00:00Z'),
      notice('b','Online assessment 31-Oct-26 at 8:00 PM IST.','2026-10-29T08:00:00Z'),
      notice('c','Online assessment rescheduled to 01-Nov-26.','2026-10-29T09:00:00Z'),
    ]) for(const event of extractActions(message,job)) db.prepare('INSERT INTO docket_events VALUES(?,?,?,?,?,?)').run(event.id,accountId,job.id,JSON.stringify(event),event.evidence.sourceRef,message.internalDate);
    assert.equal(rebuildCareerActions(db,accountId),1);
    let brief=careerBriefing(db,{accountId,jobId:job.id});
    assert.equal(brief.actions.length,1);
    assert.equal(brief.actions[0].state,'needs_review');
    assert.equal(brief.actions[0].dueAt,null);
    assert.equal(brief.bestResume.fitPercent,null);
    assert.equal(db.prepare("SELECT count(*) n FROM career_actions WHERE state='superseded'").get().n,1);
    const first=prepareCareerInterview(db,{accountId,jobId:job.id});
    assert.equal(first.state,'ready');
    answerSensei(db,{sessionId:first.session.sessionId,answer:'Fixture answer: I deployed a Python service using Docker.'});
    recordSenseiFeedback(db,{sessionId:first.session.sessionId,score:2,feedback:'Fixture feedback: explain deployment checks.',followUp:'How did you verify the container deployment?'});
    db.close(); db=openStore(file);
    assert.equal(rebuildCareerActions(db,accountId),1);
    const next=prepareCareerInterview(db,{accountId,jobId:job.id});
    assert.equal(next.session.prompt,'How did you verify the container deployment?');
    assert.equal(next.briefing.interviewHistory[0].score,2);
  } finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('reschedule without a stated date is an explicit review item', () => {
  const message={accountId:'student@example.edu',messageId:'unknown',subject:'OA rescheduled',bodyText:'Online assessment postponed. Revised schedule to follow.',internalDate:'2026-10-29T10:00:00Z',fetchedAt:'2026-10-29T10:00:00Z',sourceRef:'gmail:student@example.edu/unknown'};
  const [event]=extractActions(message,{id:'44444444-4444-4444-8444-444444444444',company:'Example',title:'Analyst'});
  assert.equal(event.needsReview,true);
  assert.equal(event.dueAt,null);
  assert.equal(event.reviewReason,'rescheduled_date_unresolved');
});
