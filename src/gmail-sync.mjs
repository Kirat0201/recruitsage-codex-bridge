import { gmailClient } from './gmail-http.mjs';
import { normalizeAccountId } from './gmail-auth.mjs';
import { gmailAccount, gmailMessage, initGmailStore, listDocket, saveGmailSync, claimTriage, finishTriage, triageCounts, triageReviewItems } from './gmail-store.mjs';
import { getApplicationStatus } from './jobs.mjs';
import { analyzeShortlistEmail, discoverGmailAttachments, resolveShortlistJob, shortlistCandidate } from './shortlist.mjs';

const MAX_BODY = 16_000;
const MAX_SCAN = 100;
const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
const bounded = (value, length) => String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ').slice(0, length);
const header = (payload, name) => payload?.headers?.find(item => item.name?.toLowerCase() === name)?.value ?? '';
function bodyText(part, depth = 0) {
  if (!part || depth > 10) return '';
  if (part.mimeType === 'text/plain' && typeof part.body?.data === 'string' && /^[A-Za-z0-9_-]+$/.test(part.body.data)) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(part.body.data, 'base64url')).slice(0, MAX_BODY); }
    catch { return ''; }
  }
  return (part.parts ?? []).slice(0, 40).map(child => bodyText(child, depth + 1)).filter(Boolean).join('\n').slice(0, MAX_BODY);
}
export function normalizeGmailMessage(raw, accountId, fetchedAt = new Date().toISOString()) {
  if (typeof raw?.id !== 'string' || typeof raw?.threadId !== 'string') throw new Error('Gmail message identity is missing');
  const rawDate = Number(raw.internalDate);
  return {
    accountId: normalizeAccountId(accountId), messageId: raw.id, threadId: raw.threadId,
    historyId: String(raw.historyId ?? ''), subject: bounded(header(raw.payload, 'subject'), 300),
    from: bounded(header(raw.payload, 'from'), 300), to: bounded(header(raw.payload, 'to'), 300),
    headerDate: bounded(header(raw.payload, 'date'), 120),
    internalDate: Number.isFinite(rawDate) && rawDate > 0 ? new Date(rawDate).toISOString() : null,
    snippet: bounded(raw.snippet, 300), bodyText: bodyText(raw.payload), labelIds: Array.isArray(raw.labelIds) ? raw.labelIds.slice(0, 30) : [],
    attachments: raw.payload ? discoverGmailAttachments(raw).slice(0, 20) : [],
    fetchedAt, sourceRef: `gmail:${normalizeAccountId(accountId)}/${raw.id}`,
  };
}
export function placementMatches(message, config) {
  const subject = message.subject.toLowerCase();
  const sender = (message.from.match(/<([^>]+)>/)?.[1] ?? message.from).toLowerCase();
  return config.subjectTerms.some(term => subject.includes(term.toLowerCase())) ||
    config.senderDomains.some(domain => sender.endsWith(`@${domain.toLowerCase()}`));
}
function docketForMessage(db, message, jobRows) {
  const content = normalize(`${message.subject} ${message.bodyText}`);
  const sourceText = `${message.subject} ${message.bodyText}`.toLowerCase();
  const output = [];
  for (const row of jobRows) {
    const job = JSON.parse(row.payload);
    const company = normalize(job.company), role = normalize(job.title);
    if (!role || !company) continue;
    const exactId = sourceText.includes(job.id.toLowerCase());
    const roleMatch = content.includes(role);
    const companyMatch = content.includes(company);
    const firstCompanyToken = company.split(' ')[0];
    const aliasMatch = firstCompanyToken.length >= 6 && content.includes(firstCompanyToken);
    if (!exactId && !(roleMatch && (companyMatch || aliasMatch))) continue;
    const app = getApplicationStatus(db, job.id);
    const confidence = exactId || companyMatch ? 'exact_identity' : 'review_required';
    output.push({
      jobId: job.id, accountId: message.accountId, messageId: message.messageId,
      company: job.company, role: job.title, confidence,
      matchBasis: exactId ? 'recruitsage_job_id_in_email' : companyMatch ? 'exact_company_and_role_text' : 'company_token_and_exact_role_text',
      unresolvedConflicts: confidence === 'review_required' ? ['Full company name not present in email text'] : [],
      applicationStatus: app?.status ?? null, applicationStatusSource: app ? 'RecruitSage application snapshot' : 'no RecruitSage application row',
      selectionStatus: null, assessmentDate: null, interviewDate: null, deadline: job.applicationDeadline ?? null,
      actions: extractActions(message, job),
      nextActionableEvent: null,
      email: { subject: message.subject, from: message.from, internalDate: message.internalDate, threadId: message.threadId },
      evidence: { recruitsage: { jobId: job.id, source: job.source ?? 'job bundle cache', syncedAt: row.last_seen },
        gmail: { accountId: message.accountId, messageId: message.messageId, sourceRef: message.sourceRef, fetchedAt: message.fetchedAt } },
      freshness: { recruitsageSnapshotAt: row.last_seen, gmailFetchedAt: message.fetchedAt },
    });
  }
  return output;
}

export function extractActions(message, job) {
  const source = `${message.subject}\n${message.bodyText}`;
  const actions = [];
  const patterns = [
    ['application_deadline', /(?:application|apply|registration|last date|deadline)[^\n.]{0,120}?(\d{1,2}(?:st|nd|rd|th)?[\s-]+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?|\d{1,2})(?:[\s,-]+(?:20)?\d{2})?)/ig],
    ['oa', /(?:online assessment|\bOA\b|test|assessment)[^\n.]{0,120}?(\d{1,2}(?:st|nd|rd|th)?[\s-]+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?|\d{1,2})(?:[\s,-]+(?:20)?\d{2})?)/ig],
    ['interview', /(?:interview|group discussion|\bGD\b)[^\n.]{0,120}?(\d{1,2}(?:st|nd|rd|th)?[\s-]+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?|\d{1,2})(?:[\s,-]+(?:20)?\d{2})?)/ig],
  ];
  for (const [type, re] of patterns) for (const m of source.matchAll(re)) {
    const dateText = m[1], yearText = dateText.match(/(?:20)?\d{2}$/)?.[0];
    const fallbackYear = new Date(message.internalDate ?? message.fetchedAt).getUTCFullYear();
    const year = yearText ? +(yearText.length === 2 ? `20${yearText}` : yearText) : fallbackYear;
    const numeric = dateText.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s-]+(\d{1,2})/i);
    const monthNames = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const monthWord = dateText.match(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*/i)?.[0]?.slice(0,3).toLowerCase();
    const month = numeric ? +numeric[2] : monthNames.indexOf(monthWord)+1;
    const day = +(dateText.match(/^\d{1,2}/)?.[0] ?? 0);
    if (!day || month < 1 || month > 12) continue;
    const normalized = new Date(Date.UTC(year, month-1, day, 0, 0));
    if (normalized.getUTCDate() !== day || normalized.getUTCMonth() !== month-1) continue;
    if (Number.isNaN(+normalized)) continue;
    const context = source.slice(Math.max(0, m.index - 100), Math.min(source.length, m.index + m[0].length + 100));
    const nearDate = source.slice(Math.max(0,m.index-45),Math.min(source.length,m.index+m[0].length+45));
    const clock = nearDate.match(/\b(\d{1,2}):(\d{2})\s*(AM|PM)\s*(IST|India Standard Time)\b/i);
    let dueAt = null;
    if (clock && +clock[1] >= 1 && +clock[1] <= 12 && +clock[2] <= 59) { const hour = (+clock[1] % 12) + (clock[3].toUpperCase()==='PM'?12:0); dueAt = new Date(Date.UTC(year,month-1,day,hour,+clock[2])-330*60_000).toISOString(); }
    const localDate = normalized.toISOString().slice(0,10);
    const uncertain = !yearText || !dueAt;
    actions.push({ id: `${message.accountId}:${message.messageId}:${type}:${normalized.toISOString().slice(0,10)}`, type,
      title: `${type.replace('_',' ')} — ${job.company} ${job.title}`, dueAt, localDate, publishedAt:message.internalDate, timezone:'Asia/Kolkata', precision:dueAt?'minute':'date_only', needsReview:uncertain, reviewReason:!yearText?'year_inferred_from_message':!dueAt?'exact_IST_time_not_stated':null, reschedule:/reschedul|postpon|revis(?:ed|ion)/i.test(context), priority: type === 'application_deadline' ? 'high' : 'normal',
      evidence: { sourceRef: message.sourceRef, messageId: message.messageId, fetchedAt: message.fetchedAt, quote: context.slice(0,220) } });
  }
  if (!actions.length && /reschedul|postpon|revis(?:ed|ion)/i.test(source)) {
    const type = /interview|group discussion|\bGD\b/i.test(source) ? 'interview' : /online assessment|\bOA\b|\btest\b|assessment/i.test(source) ? 'oa' : null;
    if (type) actions.push({ id:`${message.accountId}:${message.messageId}:${type}:unresolved`,type,
      title:`Review rescheduled ${type} — ${job.company} ${job.title}`,dueAt:null,localDate:null,publishedAt:message.internalDate,
      timezone:'Asia/Kolkata',precision:'unknown',needsReview:true,reviewReason:'rescheduled_date_unresolved',reschedule:true,priority:'high',
      evidence:{sourceRef:message.sourceRef,messageId:message.messageId,fetchedAt:message.fetchedAt,quote:source.slice(0,220)} });
  }
  if (job.applicationDeadline && /^\d{4}-\d\d-\d\d/.test(job.applicationDeadline)) actions.push({
    id: `recruitsage:${job.id}:deadline:${job.applicationDeadline.slice(0,10)}`, type: 'application_deadline', title: `Application deadline — ${job.company} ${job.title}`,
    dueAt: /T\d\d:\d\d/.test(job.applicationDeadline) && /(?:Z|[+-]\d\d:?\d\d)$/.test(job.applicationDeadline) ? new Date(job.applicationDeadline).toISOString() : null,
    localDate: job.applicationDeadline.slice(0,10), precision: /T\d\d:\d\d/.test(job.applicationDeadline) && /(?:Z|[+-]\d\d:?\d\d)$/.test(job.applicationDeadline) ? 'minute' : 'date_only',
    needsReview: true, reviewReason: 'verify_portal_deadline', priority: 'high', evidence: { source: 'RecruitSage job snapshot', jobId: job.id } });
  return [...new Map(actions.map(a => [a.id,a])).values()];
}

async function initialScan(db, account, client, { maxMessages, maxPages, now, reconcile = false }) {
  let calls = 0;
  const profile = await client.profile(account.accountId); calls++;
  const anchor = String(profile.historyId ?? '');
  if (!/^\d+$/.test(anchor) || normalizeAccountId(profile.emailAddress) !== account.accountId) throw new Error('Gmail profile does not match configured account');
  const existing = new Set(db.prepare('SELECT message_id FROM gmail_messages WHERE account_id=? AND deleted_at IS NULL').all(account.accountId).map(row => row.message_id));
  const seen = new Set(), messages = [];
  let pageToken;
  for (let page = 0; page < maxPages; page++) {
    const result = await client.listMessages(account.accountId, { q: account.placementQuery, pageToken, maxResults: Math.min(100, maxMessages - seen.size) }); calls++;
    for (const item of result.messages ?? []) {
      if (!item.id || seen.has(item.id)) continue;
      seen.add(item.id);
      if (seen.size > maxMessages) throw new Error('Gmail initial scan exceeded its message limit; narrow the placement query');
      if (existing.has(item.id)) {
        const cached = gmailMessage(db, account.accountId, item.id);
        if (cached && placementMatches(cached, account)) messages.push(cached);
        continue;
      }
      let raw;
      try { raw = await client.getMessage(account.accountId, item.id, 'full'); calls++; }
      catch (error) { if (error.code === 'GMAIL_NOT_FOUND') continue; throw error; }
      const normalized = normalizeGmailMessage(raw, account.accountId, now());
      if (placementMatches(normalized, account)) messages.push(normalized);
    }
    pageToken = result.nextPageToken;
    if (!pageToken) break;
    if (page === maxPages - 1 || seen.size >= maxMessages) throw new Error('Gmail initial scan was truncated; narrow the placement query');
  }
  const deletedIds = reconcile ? [...existing].filter(id => !seen.has(id)) : [];
  return { historyId: anchor, messages, deletedIds, calls, mode: reconcile ? 'cursor_recovery' : 'initial' };
}

async function incrementalScan(db, account, client, { maxPages, now }) {
  let calls = 0, pageToken, latestCursor = account.historyId;
  const changed = new Set(), deleted = new Set();
  for (let page = 0; page < maxPages; page++) {
    const result = await client.listHistory(account.accountId, { startHistoryId: account.historyId, pageToken }); calls++;
    if (/^\d+$/.test(String(result.historyId ?? ''))) latestCursor = String(result.historyId);
    for (const event of result.history ?? []) {
      for (const row of event.messagesAdded ?? []) if (row.message?.id) changed.add(row.message.id);
      for (const row of event.labelsAdded ?? []) if (row.message?.id) changed.add(row.message.id);
      for (const row of event.labelsRemoved ?? []) if (row.message?.id) changed.add(row.message.id);
      for (const row of event.messagesDeleted ?? []) if (row.message?.id) deleted.add(row.message.id);
    }
    pageToken = result.nextPageToken;
    if (!pageToken) break;
    if (page === maxPages - 1) throw new Error('Gmail history pagination exceeded its bounded page limit');
  }
  const messages = [];
  for (const id of changed) {
    if (deleted.has(id)) continue;
    let meta;
    try { meta = await client.getMessage(account.accountId, id, 'metadata'); calls++; }
    catch (error) { if (error.code === 'GMAIL_NOT_FOUND') { deleted.add(id); continue; } throw error; }
    const summary = normalizeGmailMessage(meta, account.accountId, now());
    const placementMatch = placementMatches(summary, account);
    const shortlistSubject = /shortlist|selected|qualified/i.test(summary.subject);
    if (!placementMatch && !shortlistSubject) continue;
    const prior = gmailMessage(db, account.accountId, id);
    if (prior) {
      messages.push({ ...prior, labelIds: summary.labelIds, historyId: summary.historyId, metadataCheckedAt: now() });
      continue;
    }
    let raw;
    try { raw = await client.getMessage(account.accountId, id, 'full'); calls++; }
    catch (error) { if (error.code === 'GMAIL_NOT_FOUND') { deleted.add(id); continue; } throw error; }
    const normalized = normalizeGmailMessage(raw, account.accountId, now());
    if (placementMatch || shortlistCandidate(normalized)) messages.push(normalized);
  }
  return { historyId: latestCursor, messages, deletedIds: [...deleted], calls, mode: 'incremental' };
}

async function drainTriage(db, accountId, client, limit = 3, deps = {}) {
  const summary = { reviewedMessages: 0, newEvents: 0, unresolved: 0, errors: 0, references: [], gmailApiCalls: 0 };
  const trackedClient = Object.create(client);
  for (const method of ['getMessage','getAttachment']) trackedClient[method] = (...args) => { summary.gmailApiCalls++; return client[method](...args); };
  const cutoff = new Date(Date.now() + 1000).toISOString();
  const handled = [];
  for (let i = 0; i < limit; i++) {
    const messageId = claimTriage(db, accountId, cutoff, handled);
    if (!messageId) break;
    handled.push(messageId);
    const ref = `gmail:${accountId}/${messageId}`;
    try {
      const message = gmailMessage(db, accountId, messageId);
      if (!message) { finishTriage(db, accountId, messageId, 'needs_review', 'message_missing'); summary.unresolved++; continue; }
      const match = resolveShortlistJob(db, message);
      if (!match.jobId) { finishTriage(db, accountId, messageId, 'needs_review', match.reason); summary.unresolved++; summary.references.push(ref); continue; }
      const before = db.prepare('SELECT COUNT(*) AS n FROM selection_events WHERE account_id=? AND message_id=?').get(accountId,messageId).n;
      const result = await (deps.analyze ?? analyzeShortlistEmail)(db, { accountId, messageId, jobId: match.jobId }, { client: trackedClient, ...deps });
      const after = db.prepare('SELECT COUNT(*) AS n FROM selection_events WHERE account_id=? AND message_id=?').get(accountId,messageId).n;
      summary.newEvents += Math.max(0, after - before);
      summary.reviewedMessages++;
      const results = result.results ?? [];
      const error = results.find(item => item.state === 'extraction_error');
      const review = result.state === 'needs_review' || results.some(item => item.state === 'needs_review' || ['needs_review','unknown'].includes(item.outcome));
      if (error) {
        const permanent = /^(INVALID_|UNSAFE_|UNSUPPORTED_|ATTACHMENT_LIMIT|MIME_LIMIT)/.test(error.code ?? '');
        finishTriage(db, accountId, messageId, permanent ? 'needs_review' : 'error', error.code);
        if (permanent) summary.unresolved++; else summary.errors++;
      }
      else if (review || !results.some(item => item.state === 'analyzed')) { finishTriage(db, accountId, messageId, 'needs_review', result.reason ?? results.find(item => item.reason)?.reason ?? 'no_verified_event'); summary.unresolved++; }
      else finishTriage(db, accountId, messageId, 'done');
      summary.references.push(ref);
    } catch (error) {
      finishTriage(db, accountId, messageId, 'error', error.code ?? 'TRIAGE_ERROR');
      summary.errors++; summary.references.push(ref);
    }
  }
  return { ...summary, queue: triageCounts(db, accountId), review: triageReviewItems(db, accountId) };
}

export async function syncGmail(db, { accountId, freshness = 'auto', maxMessages = 100, maxPages = 5 } = {}, { client = gmailClient, now = () => new Date().toISOString(), ...triageDeps } = {}) {
  initGmailStore(db);
  accountId = normalizeAccountId(accountId);
  if (!['live', 'cache', 'auto'].includes(freshness)) throw new Error('Expected Gmail freshness live, cache or auto');
  if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > MAX_SCAN || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10) throw new Error('Gmail sync bounds are invalid');
  const account = gmailAccount(db, accountId);
  if (!account) throw new Error('Gmail placement filter is not configured for this account');
  if (freshness === 'cache' || freshness === 'auto' && account.syncedAt && Date.now() - Date.parse(account.syncedAt) < 5 * 60_000 && !triageCounts(db, accountId).pending && !triageCounts(db, accountId).error) {
    return { accountId, source: 'local Gmail cache', syncedAt: account.syncedAt, historyCursorPresent: Boolean(account.historyId), gmailApiCalls: 0, skipped: true, triage: { queue: triageCounts(db, accountId), review: triageReviewItems(db, accountId) } };
  }
  let result;
  if (!account.historyId) result = await initialScan(db, account, client, { maxMessages, maxPages, now });
  else {
    try { result = await incrementalScan(db, account, client, { maxPages, now }); }
    catch (error) {
      if (error.code !== 'HISTORY_EXPIRED') throw error;
      result = await initialScan(db, account, client, { maxMessages, maxPages, now, reconcile: true });
    }
  }
  const jobRows = db.prepare('SELECT id,payload,last_seen FROM jobs WHERE present=1').all();
  const docketItems = result.messages.flatMap(message => docketForMessage(db, message, jobRows));
  const syncedAt = now();
  const triageIds = result.messages.filter(shortlistCandidate).map(message => message.messageId);
  saveGmailSync(db, { accountId, messages: result.messages, docketItems, deletedIds: result.deletedIds, triageIds, historyId: result.historyId, syncedAt });
  const triage = await drainTriage(db, accountId, client, 3, triageDeps);
  return { accountId, source: 'Gmail API', mode: result.mode, syncedAt, historyCursorPresent: true,
    messagesFetched: result.messages.length, messagesDeleted: result.deletedIds.length, docketItems: docketItems.length,
    gmailApiCalls: result.calls + triage.gmailApiCalls, skipped: false, triage };
}

export async function getPlacementDocket(db, { accountId, from, to, status, freshness = 'cache', limit = 10, offset = 0 } = {}, deps = {}) {
  initGmailStore(db);
  if (!['live', 'cache', 'auto'].includes(freshness)) throw new Error('Expected docket freshness live, cache or auto');
  let sync = null;
  if (freshness !== 'cache') sync = await syncGmail(db, { accountId, freshness }, deps);
  const linked = db.prepare('SELECT d.job_id,m.payload FROM placement_docket d JOIN gmail_messages m ON m.account_id=d.account_id AND m.message_id=d.message_id WHERE d.account_id=? AND d.active=1 AND m.deleted_at IS NULL LIMIT 500').all(normalizeAccountId(accountId));
  const saveEvent = db.prepare('INSERT INTO docket_events(event_id,account_id,job_id,payload,source_ref,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET payload=excluded.payload');
  for(const row of linked){const message=JSON.parse(row.payload),job=db.prepare('SELECT payload FROM jobs WHERE id=?').get(row.job_id);if(!job)continue;for(const action of extractActions(message,JSON.parse(job.payload)))saveEvent.run(action.id,normalizeAccountId(accountId),row.job_id,JSON.stringify(action),action.evidence?.sourceRef??`recruitsage:${row.job_id}`,new Date().toISOString());}
  const result = listDocket(db, { accountId, from, to, status, limit, offset });
  const unique = new Map();
  for (const row of db.prepare('SELECT payload FROM docket_events WHERE account_id=? LIMIT 500').all(normalizeAccountId(accountId))) {
    const action = JSON.parse(row.payload);
    if (Date.parse(action.dueAt) >= Date.now()-86400000 || action.localDate >= new Date().toISOString().slice(0,10)) unique.set(action.id, action);
  }
  for (const item of result.items) for (const action of item.actions ?? []) if (Date.parse(action.dueAt) >= Date.now()-86400000 || action.localDate >= new Date().toISOString().slice(0,10)) unique.set(action.id, action);
  const upcomingActions = [...unique.values()].sort((a,b) => (a.priority === 'high' ? 0 : 1) - (b.priority === 'high' ? 0 : 1) || String(a.dueAt??a.localDate??'').localeCompare(String(b.dueAt??b.localDate??''))).slice(0,20);
  return { ...result, freshness: { requested: freshness, actual: sync && !sync.skipped ? 'live' : 'cache', gmailApiCalls: sync?.gmailApiCalls ?? 0 },
    upcomingActions, triage: sync?.triage ?? { queue: triageCounts(db, accountId), review: triageReviewItems(db, accountId) } };
}
