import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openStore, listJobs, saveBundle } from '../src/store.mjs';
import { configureGmailAccount, gmailAccount, gmailMessage, listDocket, triageCounts, saveSelectionEvent } from '../src/gmail-store.mjs';
import { getPlacementDocket, syncGmail } from '../src/gmail-sync.mjs';

const jobId = '912928e0-6bf4-42ee-8191-1414bd50451b';
const accountA = 'student-a@example.edu', accountB = 'student-b@example.edu';
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rs-gmail-sync-'));
  const db = openStore(path.join(dir, 'jobs.sqlite'));
  saveBundle(db, { applicationRows: [{ job_id: jobId, status: 'Applied' }], revision: 1, totalJobs: 1 },
    [{ id: jobId, company: 'Deloitte India', title: 'Analyst-Cloud computing', applicationDeadline: null, source: 'get_student_job_bundle_page' }]);
  configureGmailAccount(db, { accountId: accountA, placementQuery: 'subject:Deloitte', subjectTerms: ['Deloitte'] });
  return { db, done() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function mail(id, accountId = accountA, subject = 'Deloitte Analyst - Cloud computing update') {
  return { id, threadId: `thread-${id}`, historyId: '101', internalDate: '1793210000000', labelIds: ['INBOX'],
    snippet: 'Placement update', payload: { mimeType: 'text/plain', headers: [
      { name: 'Subject', value: subject }, { name: 'From', value: 'Placement Office <placement@example.edu>' },
      { name: 'Date', value: 'Wed, 28 Oct 2026 12:00:00 +0000' },
    ], body: { data: Buffer.from(`Deloitte India Analyst Cloud computing. Account ${accountId}. This is an interview notice, not a shortlist decision.`).toString('base64url') } } };
}

test('bounded initial Gmail pages create one exact evidence-backed docket row and deduplicate repeats', async () => {
  const x = fixture();
  let full = 0, listed = 0, history = 0;
  const client = {
    profile: async () => ({ emailAddress: accountA, historyId: '100' }),
    listMessages: async (_account, options) => {
      listed++;
      return options.pageToken ? { messages: [{ id: 'm1', threadId: 't1' }, { id: 'm2', threadId: 't2' }] }
        : { messages: [{ id: 'm1', threadId: 't1' }], nextPageToken: 'next' };
    },
    getMessage: async (_account, id, format) => {
      assert.equal(format, 'full'); full++;
      return id === 'm1' ? mail(id) : mail(id, accountA, 'General newsletter');
    },
    listHistory: async () => { history++; return { historyId: '101', history: [] }; },
  };
  try {
    const first = await syncGmail(x.db, { accountId: accountA, freshness: 'live' }, { client });
    assert.equal(first.mode, 'initial'); assert.equal(first.messagesFetched, 1); assert.equal(first.docketItems, 1);
    assert.equal(first.gmailApiCalls, 5); assert.equal(listed, 2); assert.equal(full, 2);
    assert.equal(gmailAccount(x.db, accountA).historyId, '100');
    const docket = listDocket(x.db, { accountId: accountA });
    assert.equal(docket.total, 1);
    assert.equal(docket.items[0].jobId, jobId);
    assert.equal(docket.items[0].applicationStatus, 'Applied');
    assert.equal(docket.items[0].selectionStatus, null);
    assert.equal(docket.items[0].confidence, 'exact_identity');
    assert.equal(docket.items[0].evidence.gmail.messageId, 'm1');
    assert.doesNotMatch(JSON.stringify(docket), /This is an interview notice/);
    const next = await syncGmail(x.db, { accountId: accountA, freshness: 'live' }, { client });
    assert.equal(next.mode, 'incremental'); assert.equal(next.messagesFetched, 0); assert.equal(next.gmailApiCalls, 1);
    assert.equal(history, 1); assert.equal(full, 2);
    assert.equal(gmailAccount(x.db, accountA).historyId, '101');
    const cached = await getPlacementDocket(x.db, { accountId: accountA, freshness: 'cache' }, { client });
    assert.equal(cached.freshness.actual, 'cache'); assert.equal(cached.freshness.gmailApiCalls, 0);
  } finally { x.done(); }
});

test('changing placement filter invalidates old docket and reuses matching cached message without body fetch', async () => {
  const x = fixture();
  let full = 0;
  const client = {
    profile: async () => ({ emailAddress: accountA, historyId: '500' }),
    listMessages: async () => ({ messages: [{ id: 'm1', threadId: 't1' }] }),
    getMessage: async () => { full++; return mail('m1'); },
  };
  try {
    await syncGmail(x.db, { accountId: accountA, freshness: 'live' }, { client });
    assert.equal(listDocket(x.db, { accountId: accountA }).total, 1);
    configureGmailAccount(x.db, { accountId: accountA, placementQuery: 'subject:Analyst', subjectTerms: ['Analyst'] });
    assert.equal(listDocket(x.db, { accountId: accountA }).total, 0);
    await syncGmail(x.db, { accountId: accountA, freshness: 'live' }, { client });
    assert.equal(listDocket(x.db, { accountId: accountA }).total, 1);
    assert.equal(full, 1);
  } finally { x.done(); }
});

test('incremental history fetches metadata first, new matching body once, and isolates accounts', async () => {
  const x = fixture();
  const calls = { full: 0, metadata: 0 };
  const client = {
    profile: async accountId => ({ emailAddress: accountId, historyId: '200' }),
    listMessages: async () => ({ messages: [] }),
    listHistory: async () => ({ historyId: '201', history: [{ messagesAdded: [
      { message: { id: 'm3' } }, { message: { id: 'm3' } }, { message: { id: 'noise' } },
    ] }] }),
    getMessage: async (_account, id, format) => {
      calls[format]++;
      return id === 'noise' ? mail(id, accountA, 'Shopping receipt') : mail(id);
    },
  };
  try {
    await syncGmail(x.db, { accountId: accountA, freshness: 'live' }, { client });
    const result = await syncGmail(x.db, { accountId: accountA, freshness: 'live' }, { client });
    assert.equal(result.messagesFetched, 1); assert.equal(result.docketItems, 1);
    assert.equal(calls.metadata, 2); assert.equal(calls.full, 1);
    assert.equal(listDocket(x.db, { accountId: accountA }).total, 1);
    configureGmailAccount(x.db, { accountId: accountB, placementQuery: 'subject:Deloitte', subjectTerms: ['Deloitte'] });
    const otherClient = {
      profile: async () => ({ emailAddress: accountB, historyId: '300' }),
      listMessages: async () => ({ messages: [{ id: 'm3', threadId: 'other-thread' }] }),
      getMessage: async () => mail('m3', accountB),
    };
    await syncGmail(x.db, { accountId: accountB, freshness: 'live' }, { client: otherClient });
    assert.equal(listDocket(x.db, { accountId: accountA }).total, 1);
    assert.equal(listDocket(x.db, { accountId: accountB }).total, 1);
    assert.notEqual(gmailMessage(x.db, accountA, 'm3').accountId, gmailMessage(x.db, accountB, 'm3').accountId);
  } finally { x.done(); }
});

test('expired history cursor performs a bounded baseline and invalidates disappeared mail', async () => {
  const x = fixture();
  let initial = true;
  const client = {
    profile: async () => ({ emailAddress: accountA, historyId: initial ? '100' : '500' }),
    listMessages: async () => initial ? { messages: [{ id: 'm1' }] } : { messages: [] },
    getMessage: async () => mail('m1'),
    listHistory: async () => { throw Object.assign(new Error('expired'), { code: 'HISTORY_EXPIRED' }); },
  };
  try {
    await syncGmail(x.db, { accountId: accountA, freshness: 'live' }, { client });
    assert.equal(listDocket(x.db, { accountId: accountA }).total, 1);
    initial = false;
    const result = await syncGmail(x.db, { accountId: accountA, freshness: 'live' }, { client });
    assert.equal(result.mode, 'cursor_recovery');
    assert.equal(result.messagesDeleted, 1);
    assert.equal(gmailAccount(x.db, accountA).historyId, '500');
    assert.equal(listDocket(x.db, { accountId: accountA }).total, 0);
    assert.equal(gmailMessage(x.db, accountA, 'm1'), null);
  } finally { x.done(); }
});

test('missing Gmail permission leaves RecruitSage cache available and does not advance history', async () => {
  const x = fixture();
  try {
    const denied = { profile: async () => { throw Object.assign(new Error('denied'), { code: 'GMAIL_PERMISSION_DENIED' }); } };
    await assert.rejects(syncGmail(x.db, { accountId: accountA, freshness: 'live' }, { client: denied }), { code: 'GMAIL_PERMISSION_DENIED' });
    assert.equal(gmailAccount(x.db, accountA).historyId, null);
    assert.equal(listJobs(x.db).total, 1);
  } finally { x.done(); }
});

test('new shortlist is queued atomically, processed once, and attachment work is not repeated', async () => {
  const x = fixture(); let analyzed = 0;
  const raw = mail('short1', accountA, 'Deloitte Cloud computing GD shortlist');
  raw.payload = { mimeType: 'multipart/mixed', headers: raw.payload.headers,
    parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('Candidates shortlisted for GD').toString('base64url') } },
      { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: 'GD shortlist.xlsx', body: { attachmentId: 'att1', size: 10 } }] };
  const client = { profile: async () => ({ emailAddress: accountA, historyId: '100' }),
    listMessages: async () => ({ messages: [{ id: raw.id }] }), listHistory: async () => ({ historyId: '102', history: [] }),
    getMessage: async () => raw };
  const analyze = async (db, input) => {
    analyzed++;
    const event = { eventId: 'stable1', accountId: accountA, messageId: input.messageId, jobId, attachmentId: 'att1',
      documentHash: 'a'.repeat(64), stage: 'gd', outcome: 'shortlisted', eventTimestamp: '2026-10-29T00:00:00.000Z', sourceRef: 'fixture' };
    saveSelectionEvent(db, event, { accountId: accountA, messageId: input.messageId, jobId, selectionStatus: null, email: { internalDate: event.eventTimestamp } });
    return { networkRequests: 2, results: [{ state: 'analyzed' }] };
  };
  try {
    const first = await syncGmail(x.db, { accountId: accountA, freshness: 'live' }, { client, analyze });
    assert.equal(first.triage.newEvents, 1); assert.equal(first.triage.reviewedMessages, 1);
    assert.equal(first.triage.queue.pending, 0); assert.equal(analyzed, 1);
    assert.equal(listDocket(x.db, { accountId: accountA }).items[0].stageStatuses[0].stage, 'gd');
    const second = await syncGmail(x.db, { accountId: accountA, freshness: 'live' }, { client, analyze });
    assert.equal(second.triage.newEvents, 0); assert.equal(analyzed, 1);
    assert.equal(x.db.prepare('SELECT COUNT(*) AS n FROM selection_events').get().n, 1);
  } finally { x.done(); }
});

test('failed triage survives history advancement and retries on next sync without duplicate event', async () => {
  const x = fixture(); let attempts = 0;
  const raw = mail('short2', accountA, 'Deloitte Cloud computing GD shortlist');
  raw.payload = { mimeType: 'multipart/mixed', headers: raw.payload.headers,
    parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('Candidates shortlisted for GD').toString('base64url') } },
      { mimeType: 'application/pdf', filename: 'GD shortlist.pdf', body: { attachmentId: 'att2', size: 10 } }] };
  const client = { profile: async () => ({ emailAddress: accountA, historyId: '100' }),
    listMessages: async () => ({ messages: [{ id: raw.id }] }), listHistory: async () => ({ historyId: '102', history: [] }), getMessage: async () => raw };
  const analyze = async () => { if (++attempts === 1) throw Object.assign(new Error('temporary'), { code: 'TEMPORARY' }); return { networkRequests: 1, results: [{ state: 'analyzed' }] }; };
  try {
    const first = await syncGmail(x.db, { accountId: accountA, freshness: 'live' }, { client, analyze });
    assert.equal(first.triage.errors, 1); assert.equal(first.triage.queue.error, 1); assert.equal(gmailAccount(x.db, accountA).historyId, '100');
    const second = await syncGmail(x.db, { accountId: accountA, freshness: 'live' }, { client, analyze });
    assert.equal(second.triage.reviewedMessages, 1); assert.equal(second.triage.queue.error, 0); assert.equal(attempts, 2);
    assert.equal(gmailAccount(x.db, accountA).historyId, '102');
  } finally { x.done(); }
});

test('history recognizes an outside-filter shortlist but queues ambiguous job for review', async () => {
  const x = fixture();
  const raw = mail('ey1', accountA, 'EY India shortlisted candidates');
  raw.payload = { mimeType: 'multipart/mixed', headers: raw.payload.headers,
    parts: [{ mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: 'Shortlisted candidates.xlsx', body: { attachmentId: 'att3', size: 10 } }] };
  const client = { profile: async () => ({ emailAddress: accountA, historyId: '100' }),
    listMessages: async () => ({ messages: [] }),
    listHistory: async () => ({ historyId: '102', history: [{ messagesAdded: [{ message: { id: 'ey1' } }] }] }),
    getMessage: async () => raw };
  try {
    await syncGmail(x.db, { accountId: accountA, freshness: 'live' }, { client });
    const result = await syncGmail(x.db, { accountId: accountA, freshness: 'live' }, { client });
    assert.equal(result.messagesFetched, 1); assert.equal(result.triage.unresolved, 1);
    assert.equal(result.triage.queue.needs_review, 1); assert.equal(result.triage.newEvents, 0);
    assert.equal(x.db.prepare('SELECT COUNT(*) AS n FROM selection_events').get().n, 0);
    assert.equal(gmailAccount(x.db, accountA).historyId, '102');
  } finally { x.done(); }
});
