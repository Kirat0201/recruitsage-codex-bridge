import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store.mjs';
import { initIntelligence } from '../src/intelligence.mjs';
import { registerResumeSource, getResumeSource } from '../src/resume-source.mjs';

test('editable resume source is restricted, hashed, persisted, and detects changes', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rs-resume-source-')), career = path.join(dir, 'career');
  mkdirSync(career); const source = path.join(career, 'main.tex'); writeFileSync(source, '\\documentclass{article}');
  const db = openStore(path.join(dir, 'db.sqlite')), resumeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  try {
    initIntelligence(db);
    db.prepare('INSERT INTO resumes VALUES(?,?,?,?,?,?)').run(resumeId, 'Tailored', 'resume.pdf', 'pdfhash', 'text', new Date().toISOString());
    const saved = await registerResumeSource(db, { resumeId, file: source, careerRoot: career });
    assert.equal(saved.state, 'tracked'); assert.equal(saved.sourceKind, 'tex');
    process.env.RECRUITSAGE_CAREER_ROOT = career;
    assert.equal((await getResumeSource(db, { resumeId })).state, 'current');
    writeFileSync(source, '\\documentclass{article}\\begin{document}Changed\\end{document}');
    assert.equal((await getResumeSource(db, { resumeId })).state, 'changed_since_registration');
    const outside = path.join(dir, 'outside.tex'); writeFileSync(outside, 'unsafe');
    await assert.rejects(registerResumeSource(db, { resumeId, file: outside, careerRoot: career }), /canonical career folder/);
  } finally { delete process.env.RECRUITSAGE_CAREER_ROOT; db.close(); rmSync(dir, { recursive: true, force: true }); }
});
