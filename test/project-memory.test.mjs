import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store.mjs';
import { syncProjectMemory, getProjectMemory } from '../src/project-memory.mjs';

test('project memory persists evidence, ranks it, and exposes honest gaps', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rs-projects-'));
  const root = path.join(dir, 'projects'), project = path.join(root, 'cloud-devops', 'shipper');
  mkdirSync(path.join(project, 'test'), { recursive: true });
  writeFileSync(path.join(project, 'README.md'), '# Shipper\n\nA Docker deployment service measured at 120 requests per second.\n');
  writeFileSync(path.join(project, 'package.json'), JSON.stringify({ dependencies: { express: '1.0.0' }, scripts: { test: 'node --test' } }));
  writeFileSync(path.join(project, 'index.js'), 'export const ship = true;');
  writeFileSync(path.join(project, 'test', 'ship.test.js'), '');
  const db = openStore(path.join(dir, 'memory.sqlite'));
  try {
    const first = await syncProjectMemory(db, { root });
    assert.equal(first.total, 1); assert.equal(first.added, 1);
    const second = await syncProjectMemory(db, { root });
    assert.equal(second.added, 0); assert.equal(second.changed, 0);
    const memory = getProjectMemory(db, { query: 'Docker cloud deployment', limit: 3 });
    assert.equal(memory.projects[0].name, 'shipper');
    assert.ok(memory.projects[0].match.matched.includes('docker'));
    assert.equal(memory.projects[0].assessment.state, 'resume_ready');
    db.close();
    const reopened = openStore(path.join(dir, 'memory.sqlite'));
    assert.equal(getProjectMemory(reopened, { query: 'Docker' }).total, 1);
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('project scan bounds directory-only trees and reports partial evidence', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rs-project-budget-'));
  const root = path.join(dir, 'projects'), project = path.join(root, 'tools', 'wide');
  mkdirSync(project, { recursive: true });
  for (let i = 0; i < 805; i++) mkdirSync(path.join(project, `empty-${i}`));
  const db = openStore(path.join(dir, 'memory.sqlite'));
  try {
    await syncProjectMemory(db, { root });
    const { signals } = getProjectMemory(db).projects[0];
    assert.equal(signals.scannedFiles, 0);
    assert.equal(signals.scannedEntries, 800);
    assert.equal(signals.scanLimited, true);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
