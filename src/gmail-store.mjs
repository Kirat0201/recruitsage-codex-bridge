import { normalizeAccountId } from './gmail-auth.mjs';

export function initGmailStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS gmail_accounts (
    account_id TEXT PRIMARY KEY, placement_query TEXT NOT NULL, subject_terms TEXT NOT NULL,
    sender_domains TEXT NOT NULL, history_id TEXT, synced_at TEXT, configured_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS gmail_messages (
    account_id TEXT NOT NULL, message_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    payload TEXT NOT NULL, fetched_at TEXT NOT NULL, deleted_at TEXT,
    PRIMARY KEY(account_id,message_id)
  );
  CREATE TABLE IF NOT EXISTS placement_docket (
    account_id TEXT NOT NULL, message_id TEXT NOT NULL, job_id TEXT NOT NULL,
    payload TEXT NOT NULL, updated_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, invalidated_at TEXT,
    PRIMARY KEY(account_id,message_id,job_id)
  );
  CREATE TABLE IF NOT EXISTS gmail_attachments (
    account_id TEXT NOT NULL, message_id TEXT NOT NULL, attachment_id TEXT NOT NULL,
    payload TEXT NOT NULL, sha256 TEXT, local_path TEXT, state TEXT NOT NULL, fetched_at TEXT,
    PRIMARY KEY(account_id,message_id,attachment_id)
  );
  CREATE TABLE IF NOT EXISTS selection_events (
    event_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, job_id TEXT NOT NULL, message_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL, document_hash TEXT NOT NULL, stage TEXT NOT NULL,
    outcome TEXT NOT NULL, event_timestamp TEXT NOT NULL, payload TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS gmail_triage (
    account_id TEXT NOT NULL, message_id TEXT NOT NULL, history_id TEXT NOT NULL,
    state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, reason TEXT,
    updated_at TEXT NOT NULL, PRIMARY KEY(account_id,message_id)
  );
  CREATE TABLE IF NOT EXISTS docket_events (event_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, job_id TEXT NOT NULL, payload TEXT NOT NULL, source_ref TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS gmail_messages_account_fetched ON gmail_messages(account_id,fetched_at);
  CREATE INDEX IF NOT EXISTS placement_docket_account_job ON placement_docket(account_id,job_id);
  CREATE INDEX IF NOT EXISTS selection_events_account_job ON selection_events(account_id,job_id,event_timestamp);`);
}
export function configureGmailAccount(db, { accountId, placementQuery, subjectTerms = [], senderDomains = [] }) {
  initGmailStore(db);
  accountId = normalizeAccountId(accountId);
  if (typeof placementQuery !== 'string' || !placementQuery.trim() || placementQuery.length > 300) throw new Error('A bounded Gmail placement query is required');
  if (!Array.isArray(subjectTerms) || !Array.isArray(senderDomains) || !subjectTerms.length && !senderDomains.length) throw new Error('At least one local subject term or sender domain is required');
  if (subjectTerms.some(term => typeof term !== 'string' || term.trim().length < 3 || term.length > 80) ||
      senderDomains.some(domain => typeof domain !== 'string' || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain))) throw new Error('Invalid placement filter');
  const existing = db.prepare('SELECT placement_query,subject_terms,sender_domains FROM gmail_accounts WHERE account_id=?').get(accountId);
  const terms = JSON.stringify(subjectTerms.map(term => term.trim().toLowerCase()));
  const domains = JSON.stringify(senderDomains.map(domain => domain.toLowerCase()));
  if (existing && (existing.placement_query !== placementQuery.trim() || existing.subject_terms !== terms || existing.sender_domains !== domains)) {
    // A changed filter requires a new bounded baseline; retain old rows for provenance.
    db.exec('BEGIN IMMEDIATE');
    try {
      const changedAt = new Date().toISOString();
      db.prepare('UPDATE gmail_accounts SET placement_query=?,subject_terms=?,sender_domains=?,history_id=NULL,synced_at=NULL,configured_at=? WHERE account_id=?')
        .run(placementQuery.trim(), terms, domains, changedAt, accountId);
      db.prepare('UPDATE placement_docket SET active=0,invalidated_at=? WHERE account_id=? AND active=1').run(changedAt, accountId);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } else if (!existing) {
    db.prepare('INSERT INTO gmail_accounts(account_id,placement_query,subject_terms,sender_domains,configured_at) VALUES(?,?,?,?,?)')
      .run(accountId, placementQuery.trim(), terms, domains, new Date().toISOString());
  }
  return { accountId, configured: true, query: placementQuery.trim(), subjectTerms: subjectTerms.length, senderDomains: senderDomains.length };
}
export function gmailAccount(db, accountId) {
  initGmailStore(db);
  const row = db.prepare('SELECT * FROM gmail_accounts WHERE account_id=?').get(normalizeAccountId(accountId));
  return row ? { accountId: row.account_id, placementQuery: row.placement_query,
    subjectTerms: JSON.parse(row.subject_terms), senderDomains: JSON.parse(row.sender_domains),
    historyId: row.history_id, syncedAt: row.synced_at } : null;
}
export function gmailMessage(db, accountId, messageId) {
  initGmailStore(db);
  const row = db.prepare('SELECT payload,deleted_at FROM gmail_messages WHERE account_id=? AND message_id=?').get(normalizeAccountId(accountId), messageId);
  return row && !row.deleted_at ? JSON.parse(row.payload) : null;
}
export function saveGmailSync(db, { accountId, messages = [], docketItems = [], deletedIds = [], triageIds = [], historyId, syncedAt = new Date().toISOString() }) {
  initGmailStore(db);
  accountId = normalizeAccountId(accountId);
  db.exec('BEGIN IMMEDIATE');
  try {
    const message = db.prepare('INSERT INTO gmail_messages(account_id,message_id,thread_id,payload,fetched_at,deleted_at) VALUES(?,?,?,?,?,NULL) ON CONFLICT(account_id,message_id) DO UPDATE SET thread_id=excluded.thread_id,payload=excluded.payload,fetched_at=excluded.fetched_at,deleted_at=NULL');
    const invalidate = db.prepare('UPDATE placement_docket SET active=0,invalidated_at=? WHERE account_id=? AND message_id=? AND active=1');
    const invalidateWithoutEvidence = db.prepare('UPDATE placement_docket SET active=0,invalidated_at=? WHERE account_id=? AND message_id=? AND active=1 AND NOT EXISTS (SELECT 1 FROM selection_events e WHERE e.account_id=placement_docket.account_id AND e.message_id=placement_docket.message_id AND e.job_id=placement_docket.job_id)');
    const enqueue = db.prepare(`INSERT INTO gmail_triage(account_id,message_id,history_id,state,updated_at)
      VALUES(?,?,?,'pending',?) ON CONFLICT(account_id,message_id) DO UPDATE SET
      history_id=excluded.history_id,state='pending',attempts=0,reason=NULL,updated_at=excluded.updated_at
      WHERE gmail_triage.history_id<>excluded.history_id`);
    const triageSet = new Set(triageIds);
    for (const item of messages) {
      invalidateWithoutEvidence.run(syncedAt, accountId, item.messageId);
      message.run(accountId, item.messageId, item.threadId, JSON.stringify(item), item.fetchedAt);
      if (triageSet.has(item.messageId)) enqueue.run(accountId, item.messageId, item.historyId, syncedAt);
    }
    const docket = db.prepare('INSERT INTO placement_docket(account_id,message_id,job_id,payload,updated_at,active,invalidated_at) VALUES(?,?,?,?,?,1,NULL) ON CONFLICT(account_id,message_id,job_id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at,active=1,invalidated_at=NULL');
    for (const item of docketItems) docket.run(accountId, item.messageId, item.jobId, JSON.stringify(item), syncedAt);
    const event = db.prepare('INSERT INTO docket_events(event_id,account_id,job_id,payload,source_ref,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET payload=excluded.payload');
    for (const item of docketItems) for (const action of item.actions ?? []) event.run(action.id,accountId,item.jobId,JSON.stringify(action),action.evidence?.sourceRef ?? `recruitsage:${item.jobId}`,syncedAt);
    const deleted = db.prepare('UPDATE gmail_messages SET deleted_at=? WHERE account_id=? AND message_id=?');
    for (const id of deletedIds) { deleted.run(syncedAt, accountId, id); invalidate.run(syncedAt, accountId, id); db.prepare('DELETE FROM gmail_triage WHERE account_id=? AND message_id=?').run(accountId,id); }
    db.prepare('UPDATE gmail_accounts SET history_id=?,synced_at=? WHERE account_id=?').run(String(historyId), syncedAt, accountId);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function triageCounts(db, accountId) {
  initGmailStore(db);
  const counts = { pending: 0, error: 0, needs_review: 0 };
  for (const row of db.prepare("SELECT state,COUNT(*) AS count FROM gmail_triage WHERE account_id=? AND state IN ('pending','error','needs_review','processing') GROUP BY state").all(normalizeAccountId(accountId)))
    counts[row.state === 'processing' ? 'pending' : row.state] += row.count;
  return counts;
}
export function triageReviewItems(db, accountId, limit = 10) {
  initGmailStore(db);
  return db.prepare("SELECT message_id,state,reason,updated_at FROM gmail_triage WHERE account_id=? AND state IN ('error','needs_review') ORDER BY updated_at DESC LIMIT ?")
    .all(normalizeAccountId(accountId), Math.min(Math.max(limit, 1), 10))
    .map(row => ({ sourceRef: `gmail:${normalizeAccountId(accountId)}/${row.message_id}`, state: row.state, reason: row.reason, updatedAt: row.updated_at }));
}
export function claimTriage(db, accountId, runAt, excluded = []) {
  initGmailStore(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare(`SELECT message_id FROM gmail_triage WHERE account_id=? AND
      (state='pending' OR state='error' OR (state='processing' AND updated_at<?)) AND updated_at<?
      AND message_id NOT IN (${excluded.map(() => '?').join(',') || "''"})
      ORDER BY updated_at,message_id LIMIT 1`).get(normalizeAccountId(accountId), new Date(Date.parse(runAt)-300_000).toISOString(), runAt, ...excluded);
    if (row) db.prepare("UPDATE gmail_triage SET state='processing',attempts=attempts+1,updated_at=? WHERE account_id=? AND message_id=?")
      .run(runAt, normalizeAccountId(accountId), row.message_id);
    db.exec('COMMIT'); return row?.message_id ?? null;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function finishTriage(db, accountId, messageId, state, reason = null) {
  if (!['done','error','needs_review'].includes(state)) throw new Error('Invalid triage state');
  db.prepare('UPDATE gmail_triage SET state=?,reason=?,updated_at=? WHERE account_id=? AND message_id=?')
    .run(state, reason, new Date().toISOString(), normalizeAccountId(accountId), messageId);
}
export function listDocket(db, { accountId, from, to, status, limit = 20, offset = 0 } = {}) {
  initGmailStore(db);
  accountId = normalizeAccountId(accountId);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(offset) || offset < 0) throw new Error('Invalid docket pagination');
  const account = gmailAccount(db, accountId);
  const rows = db.prepare(`SELECT d.payload,m.deleted_at FROM placement_docket d
    LEFT JOIN gmail_messages m ON m.account_id=d.account_id AND m.message_id=d.message_id
    WHERE d.account_id=? AND d.active=1 ORDER BY d.updated_at DESC,d.message_id`).all(accountId);
  const eventRows = db.prepare('SELECT payload FROM selection_events WHERE account_id=? ORDER BY event_timestamp DESC,event_id').all(accountId).map(row => JSON.parse(row.payload));
  const byJob = new Map();
  const seenEvents = new Set();
  for (const event of eventRows) {
    const key = [event.accountId, event.jobId, event.messageId, event.documentHash, event.stage].join('\0');
    if (seenEvents.has(key)) continue;
    seenEvents.add(key);
    const list = byJob.get(event.jobId) ?? [];
    list.push(event); byJob.set(event.jobId, list);
  }
  const items = rows.map(row => {
    const item = { ...JSON.parse(row.payload), emailDeletedAt: row.deleted_at ?? null };
    const events = byJob.get(item.jobId) ?? [];
    const byStage = new Map();
    for (const event of events) { const list = byStage.get(event.stage) ?? []; list.push(event); byStage.set(event.stage, list); }
    const stageStatuses = [...byStage].map(([stage, history]) => {
      const latest = history[0];
      const conflict = history.some(previous => previous.outcome !== latest.outcome &&
        !(latest.releaseKind === 'revised' && latest.eventTimestamp > previous.eventTimestamp));
      return { stage, outcome: conflict ? 'needs_review' : latest.outcome,
        eventId: latest.eventId, eventTimestamp: latest.eventTimestamp, sourceRef: latest.sourceRef,
        needsReview: conflict || latest.outcome === 'needs_review', conflict,
        nextAction: conflict ? 'Review conflicting shortlist releases' : latest.nextAction ?? null };
    });
    const currentStage = stageStatuses.find(stage => stage.stage === events[0]?.stage);
    return { ...item, selectionStatus: currentStage?.outcome ?? item.selectionStatus,
      stageStatuses, selectionEventCount: events.length };
  })
    .filter(item => (!from || item.email?.internalDate >= from) && (!to || item.email?.internalDate <= to) && (!status || item.selectionStatus === status || item.applicationStatus === status));
  return { source: 'local unified docket cache', accountId, syncedAt: account?.syncedAt ?? null, total: items.length,
    offset, items: items.slice(offset, offset + limit), nextOffset: offset + limit < items.length ? offset + limit : null };
}

export function cachedGmailAttachment(db, accountId, messageId, attachmentId) {
  initGmailStore(db);
  const row = db.prepare('SELECT payload,sha256,local_path,state,fetched_at FROM gmail_attachments WHERE account_id=? AND message_id=? AND attachment_id=?')
    .get(normalizeAccountId(accountId), messageId, attachmentId);
  return row ? { ...JSON.parse(row.payload), sha256: row.sha256, localPath: row.local_path, state: row.state, fetchedAt: row.fetched_at } : null;
}

export function cachedGmailAttachmentByMetadata(db, accountId, messageId, meta) {
  initGmailStore(db);
  const rows = db.prepare('SELECT payload,sha256,local_path,state,fetched_at FROM gmail_attachments WHERE account_id=? AND message_id=? AND state=?')
    .all(normalizeAccountId(accountId), messageId, 'stored').map(row => ({ ...JSON.parse(row.payload), sha256: row.sha256,
      localPath: row.local_path, state: row.state, fetchedAt: row.fetched_at }))
    .filter(row => row.filename === meta.filename && row.mime === meta.mime && row.declaredSize === meta.declaredSize);
  return rows.length && rows.every(row => row.sha256 === rows[0].sha256) ? rows[0] : null;
}

export function saveGmailAttachment(db, item) {
  initGmailStore(db);
  db.prepare('INSERT INTO gmail_attachments(account_id,message_id,attachment_id,payload,sha256,local_path,state,fetched_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(account_id,message_id,attachment_id) DO UPDATE SET payload=excluded.payload,sha256=excluded.sha256,local_path=excluded.local_path,state=excluded.state,fetched_at=excluded.fetched_at')
    .run(normalizeAccountId(item.accountId), item.messageId, item.attachmentId,
      JSON.stringify({ filename: item.filename, mime: item.mime, declaredSize: item.declaredSize }),
      item.sha256 ?? null, item.localPath ?? null, item.state, item.fetchedAt ?? null);
}

export function saveSelectionEvent(db, event, docketItem) {
  initGmailStore(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO selection_events(event_id,account_id,job_id,message_id,attachment_id,document_hash,stage,outcome,event_timestamp,payload) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET outcome=excluded.outcome,event_timestamp=excluded.event_timestamp,payload=excluded.payload')
      .run(event.eventId, normalizeAccountId(event.accountId), event.jobId, event.messageId, event.attachmentId,
        event.documentHash, event.stage, event.outcome, event.eventTimestamp, JSON.stringify(event));
    db.prepare('INSERT INTO placement_docket(account_id,message_id,job_id,payload,updated_at,active,invalidated_at) VALUES(?,?,?,?,?,1,NULL) ON CONFLICT(account_id,message_id,job_id) DO UPDATE SET active=1,invalidated_at=NULL')
      .run(normalizeAccountId(event.accountId), event.messageId, event.jobId, JSON.stringify(docketItem), event.eventTimestamp);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function listSelectionEvents(db, { accountId, jobId, limit = 20, offset = 0 }) {
  initGmailStore(db);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(offset) || offset < 0) throw new Error('Invalid event pagination');
  const account = normalizeAccountId(accountId);
  const unique = new Map();
  for (const row of db.prepare('SELECT payload FROM selection_events WHERE account_id=? AND job_id=? ORDER BY event_timestamp DESC,event_id').all(account, jobId)) {
    const event = JSON.parse(row.payload), key = [event.messageId, event.documentHash, event.stage].join('\0');
    if (!unique.has(key)) unique.set(key, event);
  }
  const total = unique.size;
  const events = [...unique.values()].slice(offset, offset + limit).map(({ attachmentId, ...safe }) => safe);
  return { accountId: account, jobId, source: 'local selection evidence cache', total, offset, events,
    nextOffset: offset + limit < total ? offset + limit : null };
}
