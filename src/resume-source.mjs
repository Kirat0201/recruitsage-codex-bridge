import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { initIntelligence } from './intelligence.mjs';

const DEFAULT_CAREER_ROOT = '/Users/harkiratkalra/harkirat/career';
const ALLOWED = new Set(['.tex', '.docx', '.typ']);

export function initResumeSources(db) {
  initIntelligence(db);
  db.exec(`CREATE TABLE IF NOT EXISTS resume_sources (
    resume_id TEXT PRIMARY KEY, source_path TEXT NOT NULL, source_kind TEXT NOT NULL,
    sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, registered_at TEXT NOT NULL, checked_at TEXT NOT NULL
  );`);
}

async function safeSource(file, careerRoot) {
  const [root, resolved] = await Promise.all([realpath(careerRoot), realpath(file)]);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw Error('Editable resume source must be inside the canonical career folder');
  const info = await stat(resolved);
  if (!info.isFile() || info.size > 2 * 1024 * 1024) throw Error('Editable resume source must be a file under 2 MB');
  const extension = path.extname(resolved).toLowerCase();
  if (!ALLOWED.has(extension)) throw Error('Editable resume source must be LaTeX, DOCX, or Typst');
  const bytes = await readFile(resolved);
  return { resolved, extension, size: info.size, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export async function registerResumeSource(db, { resumeId, file, careerRoot = process.env.RECRUITSAGE_CAREER_ROOT || DEFAULT_CAREER_ROOT } = {}) {
  initResumeSources(db);
  const resume = db.prepare('SELECT id,label,sha256 FROM resumes WHERE id=?').get(resumeId);
  if (!resume) throw Error('Imported resume not found');
  const source = await safeSource(file, careerRoot);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO resume_sources(resume_id,source_path,source_kind,sha256,bytes,registered_at,checked_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(resume_id) DO UPDATE SET source_path=excluded.source_path,source_kind=excluded.source_kind,sha256=excluded.sha256,bytes=excluded.bytes,checked_at=excluded.checked_at`)
    .run(resumeId, source.resolved, source.extension.slice(1), source.sha256, source.size, now, now);
  return { resumeId, resumeLabel: resume.label, resumeHash: resume.sha256, sourcePath: source.resolved, sourceKind: source.extension.slice(1), sourceHash: source.sha256, bytes: source.size, state: 'tracked', checkedAt: now };
}

export async function getResumeSource(db, { resumeId } = {}) {
  initResumeSources(db);
  const row = db.prepare('SELECT * FROM resume_sources WHERE resume_id=?').get(resumeId);
  if (!row) return { resumeId, state: 'not_tracked' };
  try {
    const source = await safeSource(row.source_path, process.env.RECRUITSAGE_CAREER_ROOT || DEFAULT_CAREER_ROOT);
    const state = source.sha256 === row.sha256 ? 'current' : 'changed_since_registration';
    const checkedAt = new Date().toISOString();
    db.prepare('UPDATE resume_sources SET checked_at=? WHERE resume_id=?').run(checkedAt, resumeId);
    return { resumeId, state, sourcePath: row.source_path, sourceKind: row.source_kind, registeredHash: row.sha256, currentHash: source.sha256, bytes: source.size, registeredAt: row.registered_at, checkedAt };
  } catch (error) {
    return { resumeId, state: 'unavailable', sourcePath: row.source_path, sourceKind: row.source_kind, registeredHash: row.sha256, registeredAt: row.registered_at, reason: error.message };
  }
}
