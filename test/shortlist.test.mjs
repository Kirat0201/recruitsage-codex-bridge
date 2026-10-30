import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { openStore, saveBundle } from '../src/store.mjs';
import { configureGmailAccount, listDocket, listSelectionEvents, saveSelectionEvent, saveGmailSync } from '../src/gmail-store.mjs';
import { saveStudentIdentity } from '../src/student-identity.mjs';
import { parseShortlistWorkbook, matchStudentInWorkbook } from '../src/shortlist-xlsx.mjs';
import { analyzeShortlistEmail } from '../src/shortlist.mjs';
import { syncGmail } from '../src/gmail-sync.mjs';

const account = 'student@example.edu', jobId = '912928e0-6bf4-42ee-8191-1414bd50451b';
const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const col = number => String.fromCharCode(65 + number);
function workbook(sheets, { formula = false, extra = {} } = {}) {
  const files = {
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': strToU8(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((x, i) => `<sheet name="${esc(x.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`),
  };
  sheets.forEach((sheet, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet.rows.map((row, r) => `<row r="${r + 1}">${row.map((value, c) => value === null ? '' : `<c r="${col(c)}${r + 1}" t="inlineStr"><is><t>${esc(value)}</t></is>${formula && r === 1 && c === 0 ? '<f>1+1</f>' : ''}</c>`).join('')}</row>`).join('')}</sheetData></worksheet>`);
  });
  for (const [name, value] of Object.entries(extra)) files[name] = strToU8(value);
  return Buffer.from(zipSync(files));
}
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rs-shortlist-'));
  const db = openStore(path.join(dir, 'store.sqlite'));
  saveBundle(db, { revision: 1, totalJobs: 1, applicationRows: [{ job_id: jobId, status: 'Applied' }] },
    [{ id: jobId, company: 'Deloitte India', title: 'Analyst-Cloud computing', source: 'fixture' }]);
  configureGmailAccount(db, { accountId: account, placementQuery: 'subject:Deloitte', subjectTerms: ['Deloitte'] });
  return { db, dir, identityRoot: path.join(dir, 'identity'), attachmentRoot: path.join(dir, 'attachments'),
    async setup() { await saveStudentIdentity({ accountId: account, universityEmail: account, fullName: 'Student Example',
      nameVariants: [], registrationIds: ['REG-100'] }, { root: path.join(dir, 'identity') }); },
    done() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function gmail(bytes, { id = 'msg1', subject = 'Deloitte Cloud computing GD shortlist', filename = 'Shortlisted for GD_26th & 27th Oct.xlsx' } = {}) {
  const attachmentId = 'a'.repeat(404);
  return { raw: { id, threadId: `thread-${id}`, internalDate: '1792735141000',
    payload: { mimeType: 'multipart/mixed', headers: [{ name: 'Subject', value: subject }, { name: 'From', value: 'Campus <office@example.edu>' }],
      parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('Candidates shortlisted for GD').toString('base64url') } },
        { mimeType: filename.endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename,
          body: { attachmentId, size: bytes.length } }] } }, attachment: { size: bytes.length, data: bytes.toString('base64url') } };
}
function pdfFixture(text) {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return Buffer.from(pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

test('XLSX exact identity across sheets and header variations; name-only and duplicate matches require review', async () => {
  const bytes = workbook([{ name: 'Other', rows: [['Student Name', 'Roll Number'], ['Student Example', 'REG-999']] },
    { name: 'GD List', rows: [['Student Name', 'University Email', 'Registration Number'], ['Another Student', 'other@example.edu', 'REG-200'], ['Student Example', account, 'REG-100']] }]);
  const sheets = await parseShortlistWorkbook(bytes);
  const profile = { universityEmail: account, fullName: 'Student Example', nameVariants: [], registrationIds: ['REG-100'] };
  const result = matchStudentInWorkbook(sheets, profile);
  assert.equal(result.outcome, 'shortlisted'); assert.equal(result.matches[0].sheet, 'GD List'); assert.equal(result.matches[0].row, 3);
  assert.deepEqual(result.matches[0].columns.map(x => x.type), ['university_email', 'registration_id']);
  const absent = { ...profile, universityEmail: 'missing@example.edu', registrationIds: ['REG-404'] };
  assert.equal(matchStudentInWorkbook(sheets, absent).outcome, 'needs_review'); // supporting name alone
  assert.equal(matchStudentInWorkbook(sheets, { ...absent, fullName: 'No Match' }).outcome, 'unknown');
  assert.equal(matchStudentInWorkbook(sheets, { ...absent, fullName: 'No Match' }, { exhaustive: true }).outcome, 'not_listed');
  const duplicate = workbook([{ name: 'GD', rows: [['Email'], [account], [account]] }]);
  assert.equal(matchStudentInWorkbook(await parseShortlistWorkbook(duplicate), profile).outcome, 'needs_review');
});

test('XLSX rejects malformed, formula-bearing, external-link, encrypted-looking and oversized files', async () => {
  await assert.rejects(parseShortlistWorkbook(Buffer.from('bad')), { code: 'INVALID_XLSX' });
  await assert.rejects(parseShortlistWorkbook(Buffer.alloc(2 * 1024 * 1024 + 1)), { code: 'INVALID_XLSX' });
  const base = [{ name: 'GD', rows: [['Email'], [account]] }];
  await assert.rejects(parseShortlistWorkbook(workbook(base, { formula: true })), { code: 'UNSAFE_XLSX' });
  await assert.rejects(parseShortlistWorkbook(workbook(base, { extra: { 'xl/externalLinks/externalLink1.xml': '<x/>' } })), { code: 'UNSAFE_XLSX' });
  await assert.rejects(parseShortlistWorkbook(Buffer.from('d0cf11e0a1b11ae1', 'hex')), { code: 'INVALID_XLSX' });
  await assert.rejects(parseShortlistWorkbook(workbook(base, { extra: { '../escape.txt': 'bad' } })), { code: 'UNSAFE_ZIP' });
  const encrypted = workbook(base);
  const central = encrypted.indexOf(Buffer.from('PK\x01\x02', 'binary'));
  encrypted.writeUInt16LE(1, central + 8);
  await assert.rejects(parseShortlistWorkbook(encrypted), { code: 'UNSUPPORTED_ZIP' });
});

test('PDF attachment uses bounded existing parser and preserves page evidence', async () => {
  const x = fixture(); await x.setup();
  const source = gmail(pdfFixture(`GD shortlist ${account} selected for group discussion.`), { filename: 'Shortlisted for GD.pdf' });
  try {
    const result = await analyzeShortlistEmail(x.db, { accountId: account, messageId: 'msg1', jobId },
      { client: { getMessage: async () => source.raw, getAttachment: async () => source.attachment },
        identityRoot: x.identityRoot, attachmentRoot: x.attachmentRoot });
    assert.equal(result.results[0].outcome, 'shortlisted');
    assert.equal(result.results[0].location[0].page, 1);
    assert.equal(result.results[0].stage, 'gd');
  } finally { x.done(); }
});

test('Gmail shortlist analysis persists exact GD evidence, reuses cached bytes, and keeps account isolation', async () => {
  const x = fixture(); await x.setup();
  const bytes = workbook([{ name: 'Sheet1', rows: [['Candidate Id', 'Primary Email'], ['different-id', account]] }]);
  const source = gmail(bytes); let downloads = 0;
  const client = { getMessage: async () => source.raw, getAttachment: async () => { downloads++; return source.attachment; } };
  try {
    const input = { accountId: account, messageId: 'msg1', jobId };
    const first = await analyzeShortlistEmail(x.db, input, { client, identityRoot: x.identityRoot, attachmentRoot: x.attachmentRoot });
    assert.equal(first.results[0].outcome, 'shortlisted'); assert.equal(first.results[0].stage, 'gd');
    assert.equal(first.results[0].identifierType, 'university_email'); assert.equal(first.results[0].location[0].row, 2);
    assert.doesNotMatch(JSON.stringify(first), /different-id/);
    assert.equal(first.results[0].reportedEventDate, '2026-10-26/2026-10-27');
    assert.equal(first.networkRequests, 2);
    const second = await analyzeShortlistEmail(x.db, input, { client, identityRoot: x.identityRoot, attachmentRoot: x.attachmentRoot });
    assert.equal(second.networkRequests, 1); assert.equal(downloads, 1);
    const events = listSelectionEvents(x.db, { accountId: account, jobId });
    assert.equal(events.total, 1); assert.equal(events.events[0].location[0].sheet, 'Sheet1');
    assert.equal(events.events[0].attachmentId, undefined);
    const docket = listDocket(x.db, { accountId: account });
    assert.equal(docket.total, 1); assert.equal(docket.items[0].stageStatuses[0].stage, 'gd');
    assert.equal(docket.items[0].stageStatuses[0].outcome, 'shortlisted');
    assert.equal(listDocket(x.db, { accountId: 'other@example.edu' }).total, 0);
    assert.equal((readFileSync(path.join(x.attachmentRoot, `${first.results[0].documentHash}.xlsx`))).length, bytes.length);
  } finally { x.done(); }
});

test('wrong job, unsupported stage and extraction errors never create a shortlist event', async () => {
  const x = fixture(); await x.setup();
  const bytes = workbook([{ name: 'GD', rows: [['Email'], [account]] }]);
  const source = gmail(bytes);
  try {
    const wrong = await analyzeShortlistEmail(x.db, { accountId: account, messageId: 'msg1', jobId },
      { client: { getMessage: async () => ({ ...source.raw, payload: { ...source.raw.payload, headers: [{ name: 'Subject', value: 'Other company Cloud computing' }] } }) }, identityRoot: x.identityRoot });
    assert.equal(wrong.state, 'needs_review');
    const unclear = gmail(bytes, { filename: 'candidates.xlsx', subject: 'Deloitte Cloud computing update' });
    const result = await analyzeShortlistEmail(x.db, { accountId: account, messageId: 'msg1', jobId },
      { client: { getMessage: async () => unclear.raw }, identityRoot: x.identityRoot });
    assert.equal(result.results[0].state, 'needs_review');
    const corrupt = await analyzeShortlistEmail(x.db, { accountId: account, messageId: 'msg1', jobId },
      { client: { getMessage: async () => source.raw, getAttachment: async () => ({ size: bytes.length, data: Buffer.alloc(bytes.length).toString('base64url') }) },
        identityRoot: x.identityRoot, attachmentRoot: x.attachmentRoot });
    assert.equal(corrupt.results[0].state, 'extraction_error'); assert.equal(listSelectionEvents(x.db, { accountId: account, jobId }).total, 0);
  } finally { x.done(); }
});

test('conflicting stage evidence requires review; an explicit revised release supersedes it without deleting history', () => {
  const x = fixture();
  try {
    const base = { accountId: account, jobId, stage: 'gd', documentHash: '1'.repeat(64), attachmentId: 'a',
      filename: 'GD shortlist.xlsx', company: 'Deloitte India', role: 'Analyst-Cloud computing',
      identifierType: 'university_email', location: [{ sheet: 'GD', row: 2, columns: [{ index: 2, type: 'university_email' }] }],
      sourceRef: 'gmail:student@example.edu/msg1/attachment:hash' };
    const docket = { accountId: account, messageId: 'msg1', jobId, email: { internalDate: '2026-10-23T00:00:00.000Z' }, selectionStatus: null };
    saveSelectionEvent(x.db, { ...base, eventId: '1', messageId: 'msg1', outcome: 'shortlisted', releaseKind: 'initial', eventTimestamp: '2026-10-23T00:00:00.000Z' }, docket);
    saveSelectionEvent(x.db, { ...base, eventId: '2', messageId: 'msg2', outcome: 'not_listed', releaseKind: 'initial', eventTimestamp: '2026-10-24T00:00:00.000Z' }, { ...docket, messageId: 'msg2' });
    let list = listDocket(x.db, { accountId: account });
    assert.equal(list.items[0].stageStatuses[0].outcome, 'needs_review');
    assert.equal(list.items[0].stageStatuses[0].conflict, true);
    saveSelectionEvent(x.db, { ...base, eventId: '3', messageId: 'msg3', outcome: 'shortlisted', releaseKind: 'revised', eventTimestamp: '2026-10-25T00:00:00.000Z' }, { ...docket, messageId: 'msg3' });
    list = listDocket(x.db, { accountId: account });
    assert.equal(list.items[0].stageStatuses[0].outcome, 'shortlisted');
    assert.equal(list.items[0].stageStatuses[0].conflict, false);
    assert.equal(listSelectionEvents(x.db, { accountId: account, jobId }).total, 3);
  } finally { x.done(); }
});

test('repeat Gmail sync retains a persisted shortlist link and does not duplicate its event', async () => {
  const x = fixture(); await x.setup();
  const bytes = workbook([{ name: 'GD', rows: [['Email'], [account]] }]);
  const source = gmail(bytes), client = { getMessage: async () => source.raw, getAttachment: async () => source.attachment };
  try {
    const input = { accountId: account, messageId: 'msg1', jobId };
    await analyzeShortlistEmail(x.db, input, { client, identityRoot: x.identityRoot, attachmentRoot: x.attachmentRoot });
    const msg = { accountId: account, messageId: 'msg1', threadId: 'thread-msg1', fetchedAt: new Date().toISOString(), subject: 'Deloitte', from: 'office@example.edu', labelIds: ['INBOX'] };
    saveGmailSync(x.db, { accountId: account, messages: [msg], historyId: '200' });
    assert.equal(listDocket(x.db, { accountId: account }).total, 1);
    assert.equal(listSelectionEvents(x.db, { accountId: account, jobId }).total, 1);
  } finally { x.done(); }
});

test('incremental shortlist triage invokes the real XLSX matcher once and keeps GD evidence', async () => {
  const x = fixture(); await x.setup();
  const bytes = workbook([{ name: 'GD Candidates', rows: [['University Email'], [account]] }]);
  const source = gmail(bytes, { id: 'triage1', subject: 'Deloitte Cloud computing GD shortlist' });
  source.raw.historyId = '101'; source.raw.labelIds = ['INBOX'];
  let downloads = 0;
  const client = { profile: async () => ({ emailAddress: account, historyId: '100' }),
    listMessages: async () => ({ messages: [{ id: 'triage1' }] }),
    listHistory: async () => ({ historyId: '102', history: [] }),
    getMessage: async () => source.raw,
    getAttachment: async () => { downloads++; return source.attachment; } };
  try {
    const deps = { client, identityRoot: x.identityRoot, attachmentRoot: x.attachmentRoot };
    const first = await syncGmail(x.db, { accountId: account, freshness: 'live' }, deps);
    assert.equal(first.triage.newEvents, 1); assert.equal(first.triage.queue.pending, 0);
    assert.equal(downloads, 1);
    const event = listSelectionEvents(x.db, { accountId: account, jobId }).events[0];
    assert.equal(event.stage, 'gd'); assert.equal(event.outcome, 'shortlisted');
    assert.equal(event.location[0].sheet, 'GD Candidates'); assert.equal(event.location[0].row, 2);
    assert.equal(listDocket(x.db, { accountId: account }).items[0].stageStatuses[0].stage, 'gd');
    const second = await syncGmail(x.db, { accountId: account, freshness: 'live' }, deps);
    assert.equal(second.triage.newEvents, 0); assert.equal(downloads, 1);
    assert.equal(listSelectionEvents(x.db, { accountId: account, jobId }).total, 1);
  } finally { x.done(); }
});
