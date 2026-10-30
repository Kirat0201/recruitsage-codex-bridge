import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url));

export function openStore(file = path.join(DATA_DIR, 'recruitsage.sqlite')) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, changed_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS applications (job_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS eligibility (job_id TEXT PRIMARY KEY, eligible INTEGER NOT NULL, closed INTEGER NOT NULL, reasons TEXT NOT NULL, checked_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, payload TEXT NOT NULL, sha256 TEXT, local_path TEXT, text_path TEXT);
    CREATE TABLE IF NOT EXISTS job_packets (job_id TEXT PRIMARY KEY, payload TEXT NOT NULL, fetched_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const columns = new Set(db.prepare('PRAGMA table_info(jobs)').all().map(row => row.name));
  if (!columns.has('present')) db.exec('ALTER TABLE jobs ADD COLUMN present INTEGER NOT NULL DEFAULT 1');
  if (!columns.has('is_new')) db.exec('ALTER TABLE jobs ADD COLUMN is_new INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('removed_at')) db.exec('ALTER TABLE jobs ADD COLUMN removed_at TEXT');
  const documentColumns = new Set(db.prepare('PRAGMA table_info(documents)').all().map(row => row.name));
  if (!documentColumns.has('downloaded_at')) db.exec('ALTER TABLE documents ADD COLUMN downloaded_at TEXT');
  return db;
}

export function metadata(db, key) { return db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value ?? null; }
export function setMetadata(db, key, value) { db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value)); }

export function saveBundle(db, bundle, jobs) {
  const now = new Date().toISOString(); let changed = 0; let added = 0; let removed = 0; let restored = 0;
  const baseline = !metadata(db, 'syncedAt');
  const seen = new Set(jobs.map(job => job.id));
  const stable = value => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === 'object'
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  db.exec('BEGIN IMMEDIATE');
  try {
    const select = db.prepare('SELECT payload,present,changed_at FROM jobs WHERE id=?');
    const insert = db.prepare('INSERT INTO jobs(id,payload,first_seen,last_seen,changed_at,present,is_new,removed_at) VALUES(?,?,?,?,?,1,?,NULL)');
    const update = db.prepare('UPDATE jobs SET payload=?,last_seen=?,changed_at=?,present=1,is_new=0,removed_at=NULL WHERE id=?');
    db.exec('UPDATE jobs SET is_new=0');
    for (const job of jobs) {
      const payload = JSON.stringify(job);
      const previous = select.get(job.id);
      if (!previous) {
        if (!baseline) added++;
        insert.run(job.id, payload, now, now, now, Number(!baseline));
      } else {
        if (!previous.present) restored++;
        const different = stable(JSON.parse(previous.payload)) !== stable(job);
        if (different) changed++;
        update.run(payload, now, different ? now : previous.changed_at, job.id);
      }
    }
    const markRemoved = db.prepare('UPDATE jobs SET present=0,is_new=0,removed_at=? WHERE id=?');
    for (const row of db.prepare('SELECT id FROM jobs WHERE present=1').all()) if (!seen.has(row.id)) { markRemoved.run(now, row.id); removed++; }
    db.exec('DELETE FROM applications');
    const app = db.prepare('INSERT INTO applications(job_id,payload) VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET payload=excluded.payload');
    for (const row of bundle.applicationRows ?? []) if (row.job_id) app.run(row.job_id, JSON.stringify(row));
    setMetadata(db, 'revision', bundle.revision ?? '');
    setMetadata(db, 'syncedAt', now);
    setMetadata(db, 'reportedTotal', bundle.totalJobs ?? jobs.length);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { stored: jobs.length, baseline, added, changed, removed, restored, revision: bundle.revision ?? null, syncedAt: now };
}

export function listJobs(db, { filter = 'all', limit = 20, offset = 0 } = {}) {
  if (!['all', 'applied', 'new'].includes(filter)) throw new Error(`Unsupported filter: ${filter}`);
  if (!metadata(db, 'syncedAt')) return { source: 'local SQLite cache', syncedAt: null, filter, total: 0, offset, jobs: [], warning: 'No live sync has completed; this is not a current job count.' };
  const where = filter === 'applied' ? 'WHERE j.present=1 AND EXISTS (SELECT 1 FROM applications a WHERE a.job_id=j.id)' : filter === 'new' ? 'WHERE j.present=1 AND j.is_new=1' : 'WHERE j.present=1';
  const count = db.prepare(`SELECT count(*) AS n FROM jobs j ${where}`).get().n;
  const rows = db.prepare(`SELECT j.payload,j.first_seen,j.changed_at FROM jobs j ${where} ORDER BY j.first_seen DESC,j.id LIMIT ? OFFSET ?`).all(Math.min(Math.max(limit, 1), 100), Math.max(offset, 0));
  return { source: 'local SQLite cache', syncedAt: metadata(db, 'syncedAt'), filter, total: count, offset, jobs: rows.map(r => { const j = JSON.parse(r.payload); return { id: j.id, title: j.title, company: j.company, location: j.location, applicationDeadline: j.applicationDeadline, applied: j.applied, applicationStatus: j.applicationStatus, firstSeen: r.first_seen, changedAt: r.changed_at }; }) };
}

export function cachedJob(db, id) { const row = db.prepare('SELECT payload FROM jobs WHERE id=?').get(id); return row ? JSON.parse(row.payload) : null; }
export function jobRecord(db, id) {
  const row = db.prepare('SELECT payload,first_seen,last_seen,changed_at,present,removed_at FROM jobs WHERE id=?').get(id);
  return row ? { job: JSON.parse(row.payload), firstSeen: row.first_seen, lastSeen: row.last_seen, changedAt: row.changed_at, present: Boolean(row.present), removedAt: row.removed_at } : null;
}

export function saveEligibility(db, rows) {
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM eligibility');
    const insert = db.prepare('INSERT INTO eligibility(job_id,eligible,closed,reasons,checked_at) VALUES(?,?,?,?,?)');
    for (const row of rows) insert.run(row.jobId, Number(row.eligible), Number(row.closed), JSON.stringify(row.reasons), now);
    setMetadata(db, 'eligibilityCheckedAt', now);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function classifiedJobs(db, { kind, limit = 20, offset = 0 } = {}) {
  const checkedAt = metadata(db, 'eligibilityCheckedAt');
  if (!checkedAt) throw new Error('Eligibility has not been checked live; run sync first');
  const where = kind === 'available' ? 'e.eligible=1 AND e.closed=0 AND a.job_id IS NULL' : kind === 'closed' ? 'e.closed=1' : null;
  if (!where) throw new Error('Unsupported classification');
  const from = 'FROM jobs j JOIN eligibility e ON e.job_id=j.id LEFT JOIN applications a ON a.job_id=j.id';
  const total = db.prepare(`SELECT count(*) AS n ${from} WHERE ${where}`).get().n;
  const rows = db.prepare(`SELECT j.payload,e.reasons ${from} WHERE ${where} ORDER BY j.first_seen DESC,j.id LIMIT ? OFFSET ?`).all(Math.min(Math.max(limit, 1), 100), Math.max(offset, 0));
  return { source: 'live eligibility RPC cached in SQLite', checkedAt, syncedAt: metadata(db, 'syncedAt'), kind, total, offset, jobs: rows.map(r => { const j = JSON.parse(r.payload); return { id: j.id, title: j.title, company: j.company, location: j.location, applicationDeadline: j.applicationDeadline, reasons: JSON.parse(r.reasons) }; }) };
}
