import { createHash } from 'node:crypto';
import { opendir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { cachedJob } from './store.mjs';

const DEFAULT_ROOT = '/Users/harkiratkalra/harkirat/projects';
const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', 'dist', 'build', 'coverage', '__pycache__', '.next']);
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.cpp', '.c', '.h', '.swift', '.dart']);
const STOP = new Set(['the', 'and', 'with', 'for', 'from', 'this', 'that', 'your', 'you', 'our', 'are', 'will', 'into', 'job', 'role', 'work', 'using']);

export function initProjectMemory(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS project_memory (
    project_path TEXT PRIMARY KEY, category TEXT NOT NULL, name TEXT NOT NULL,
    content_hash TEXT NOT NULL, payload TEXT NOT NULL, synced_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS project_memory_category ON project_memory(category,name);`);
}

const bounded = (value, max = 500) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const terms = value => [...new Set((String(value).toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g) ?? []).filter(term => !STOP.has(term)))];

async function textFile(file, limit = 24_000) {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > limit) return '';
    return (await readFile(file, 'utf8')).slice(0, limit);
  } catch { return ''; }
}

async function walkSignals(root, depth = 0, state = { source: 0, tests: 0, files: 0, entries: 0, scanLimited: false, extensions: new Map() }) {
  if (depth > 4 || state.entries >= 800) { state.scanLimited = true; return state; }
  let directory;
  try { directory = await opendir(root); } catch { return state; }
  // Stream entries and count directories too: a file-only cap permits huge empty trees.
  for await (const entry of directory) {
    if (state.entries >= 800) { state.scanLimited = true; break; }
    state.entries++;
    if (entry.isSymbolicLink() || SKIP.has(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) { await walkSignals(full, depth + 1, state); continue; }
    state.files++;
    const ext = path.extname(entry.name).toLowerCase();
    if (SOURCE_EXTENSIONS.has(ext)) {
      state.source++;
      state.extensions.set(ext, (state.extensions.get(ext) ?? 0) + 1);
    }
    if (/(^|[._-])(test|spec)s?([._-]|$)/i.test(entry.name) || /(^|\/)tests?(\/|$)/i.test(full)) state.tests++;
  }
  return state;
}

function readmeSummary(readme) {
  const lines = readme.split(/\r?\n/).map(line => line.trim());
  const paragraph = lines.find(line => line && !line.startsWith('#') && !line.startsWith('[') && !/^[-*|>`]/.test(line) && !/^<[^>]+>/.test(line));
  return bounded(paragraph || lines.find(line => /^#\s+/.test(line))?.replace(/^#+\s*/, '') || '', 420);
}

function packageEvidence(raw) {
  if (!raw) return { technologies: [], scripts: [] };
  try {
    const pkg = JSON.parse(raw);
    return {
      technologies: [...new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})])].slice(0, 30),
      scripts: Object.keys(pkg.scripts ?? {}).slice(0, 20),
    };
  } catch { return { technologies: [], scripts: [] }; }
}

async function inspectProject(category, entry, root) {
  const projectPath = path.join(root, category, entry.name);
  const [readme, packageRaw, requirements, pyproject, signals] = await Promise.all([
    textFile(path.join(projectPath, 'README.md')),
    textFile(path.join(projectPath, 'package.json')),
    textFile(path.join(projectPath, 'requirements.txt')),
    textFile(path.join(projectPath, 'pyproject.toml')),
    walkSignals(projectPath),
  ]);
  const pkg = packageEvidence(packageRaw);
  const pythonDeps = requirements.split(/\r?\n/).map(line => line.split(/[<>=~!]/)[0].trim()).filter(line => line && !line.startsWith('#')).slice(0, 30);
  const technologies = [...new Set([
    ...pkg.technologies,
    ...pythonDeps,
    ...(pyproject.match(/^[A-Za-z][A-Za-z0-9_-]+(?=\s*=)/gm) ?? []),
    ...[...signals.extensions.keys()].map(ext => ({ '.py': 'Python', '.js': 'JavaScript', '.mjs': 'JavaScript', '.ts': 'TypeScript', '.tsx': 'TypeScript/React', '.jsx': 'React', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.cpp': 'C++', '.c': 'C', '.swift': 'Swift', '.dart': 'Dart' }[ext] ?? ext)),
  ])].slice(0, 40);
  const missingEvidence = [];
  if (!readme) missingEvidence.push('README explaining the problem, architecture and your contribution');
  if (!signals.source) missingEvidence.push('source files visible in the project folder');
  if (!signals.tests && !pkg.scripts.some(script => /test/i.test(script))) missingEvidence.push('automated test evidence');
  if (!/\b(metric|latency|accuracy|users?|hours?|requests?|percent|%)\b/i.test(readme)) missingEvidence.push('measured result or scale');
  const evidenceRefs = [
    readme && `${projectPath}/README.md`,
    packageRaw && `${projectPath}/package.json`,
    requirements && `${projectPath}/requirements.txt`,
    pyproject && `${projectPath}/pyproject.toml`,
  ].filter(Boolean);
  const payload = {
    projectPath, category, name: entry.name, summary: readmeSummary(readme), technologies,
    evidenceRefs, signals: { sourceFiles: signals.source, testFiles: signals.tests, scannedFiles: signals.files, scannedEntries: signals.entries, scanLimited: signals.scanLimited, hasGit: Boolean(await stat(path.join(projectPath, '.git')).catch(() => null)) },
    assessment: { state: missingEvidence.length <= 1 ? 'resume_ready' : missingEvidence.length <= 3 ? 'needs_evidence' : 'weak_evidence', missingEvidence },
  };
  const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return { ...payload, contentHash: fingerprint };
}

export async function syncProjectMemory(db, { root = process.env.RECRUITSAGE_PROJECTS_ROOT || DEFAULT_ROOT } = {}) {
  initProjectMemory(db);
  const categories = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.name.startsWith('.'));
  const projects = [];
  for (const category of categories) {
    const entries = (await readdir(path.join(root, category.name), { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && !SKIP.has(entry.name));
    for (const entry of entries) projects.push(await inspectProject(category.name, entry, root));
  }
  const now = new Date().toISOString();
  const previous = new Map(db.prepare('SELECT project_path,content_hash FROM project_memory').all().map(row => [row.project_path, row.content_hash]));
  const seen = new Set(projects.map(project => project.projectPath));
  let added = 0, changed = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const save = db.prepare(`INSERT INTO project_memory(project_path,category,name,content_hash,payload,synced_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(project_path) DO UPDATE SET category=excluded.category,name=excluded.name,content_hash=excluded.content_hash,payload=excluded.payload,synced_at=excluded.synced_at`);
    for (const project of projects) {
      if (!previous.has(project.projectPath)) added++;
      else if (previous.get(project.projectPath) !== project.contentHash) changed++;
      save.run(project.projectPath, project.category, project.name, project.contentHash, JSON.stringify(project), now);
    }
    for (const oldPath of previous.keys()) if (!seen.has(oldPath)) db.prepare('DELETE FROM project_memory WHERE project_path=?').run(oldPath);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { source: 'local project files', root, total: projects.length, added, changed, removed: [...previous.keys()].filter(oldPath => !seen.has(oldPath)).length, syncedAt: now };
}

export function getProjectMemory(db, { jobId, query, limit = 8 } = {}) {
  initProjectMemory(db);
  const job = jobId ? cachedJob(db, jobId) : null;
  if (jobId && !job) throw Error('Job is not cached');
  const target = bounded(query || [job?.title, job?.company, job?.requirements, job?.skillsRequired].filter(Boolean).join(' '), 3000);
  const targetTerms = terms(target);
  const rows = db.prepare('SELECT payload,synced_at FROM project_memory ORDER BY name').all();
  const projects = rows.map(row => {
    const project = JSON.parse(row.payload);
    const haystack = terms([project.name, project.category, project.summary, ...(project.technologies ?? [])].join(' '));
    const matched = targetTerms.filter(term => haystack.some(candidate => candidate === term || candidate.includes(term) || term.includes(candidate)));
    const score = targetTerms.length ? Math.round((matched.length / targetTerms.length) * 100) : 0;
    return { ...project, match: { method: 'keyword_evidence_estimate', score, matched: matched.slice(0, 12) }, syncedAt: row.synced_at };
  }).sort((a, b) => b.match.score - a.match.score || a.assessment.missingEvidence.length - b.assessment.missingEvidence.length || a.name.localeCompare(b.name));
  return { source: 'local persistent project evidence', jobId: jobId ?? null, query: target || null, total: projects.length, projects: projects.slice(0, Math.min(Math.max(limit, 1), 20)), limitation: 'Fit is an estimate from local README, manifest and source-file evidence; it does not prove ownership or production impact.' };
}
