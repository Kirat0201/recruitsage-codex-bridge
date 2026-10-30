import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openStore, saveBundle, saveEligibility, listJobs, jobRecord } from '../src/store.mjs';
import { getJobPacket } from '../src/job-packet.mjs';
import { ApiError } from '../src/http.mjs';

const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const job = (id, title = 'Engineer') => ({ id, title, company: 'Example Ltd', location: 'Remote', jobType: 'Full time', applicationDeadline: null, salaryOptions: [], eligibilityRules: [] });
const bundle = jobs => ({ applicationRows: [], revision: 1, totalJobs: jobs.length });
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rs-packet-'));
  const db = openStore(path.join(dir, 'jobs.sqlite'));
  return { dir, db, done() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('first sync is a baseline; later snapshots detect additions, edits and removals', () => {
  const x = fixture();
  try {
    const initial = saveBundle(x.db, bundle([job(firstId)]), [job(firstId)]);
    assert.equal(initial.baseline, true); assert.equal(initial.added, 0);
    assert.equal(listJobs(x.db, { filter: 'new' }).total, 0);
    const later = saveBundle(x.db, bundle([job(secondId)]), [job(secondId)]);
    assert.equal(later.added, 1); assert.equal(later.removed, 1);
    assert.equal(listJobs(x.db, { filter: 'new' }).total, 1);
    assert.equal(listJobs(x.db).total, 1);
    assert.equal(jobRecord(x.db, firstId).present, false);
    const edit = saveBundle(x.db, bundle([job(secondId, 'Senior Engineer')]), [job(secondId, 'Senior Engineer')]);
    assert.equal(edit.changed, 1); assert.equal(edit.added, 0); assert.equal(edit.removed, 0);
    assert.equal(listJobs(x.db, { filter: 'new' }).total, 0);
  } finally { x.done(); }
});

test('job packet labels live and cached sources, includes bounded document evidence', async () => {
  const x = fixture();
  try {
    saveBundle(x.db, bundle([job(firstId)]), [job(firstId)]);
    saveEligibility(x.db, [{ jobId: firstId, eligible: true, closed: false, reasons: [] }]);
    const textPath = path.join(x.dir, 'description.txt');
    writeFileSync(textPath, 'Relevant responsibilities and qualifications. '.repeat(80), { mode: 0o600 });
    x.db.prepare('INSERT INTO documents(id,job_id,payload,sha256,local_path,text_path) VALUES(?,?,?,?,?,?)')
      .run('file-1', firstId, JSON.stringify({ id: 'file-1', file_path: 'job/file.pdf', extraction: { format: 'pdf', status: 'extracted' } }), 'abc123', textPath, textPath);
    let details = 0, attachments = 0, applications = 0;
    const deps = {
      getDetails: async () => { details++; return { id: firstId, title: 'Engineer', description: 'Build services. '.repeat(200), skills_required: ['Node.js'], selection_process: 'Interview', companies: { name: 'Example Ltd' } }; },
      getAttachments: async () => { attachments++; return [{ id: 'file-1', original_name: 'file.pdf', mime_type: 'application/pdf', size_bytes: 100, file_path: 'job/file.pdf' }]; },
      getApplication: async () => { applications++; return { state: 'no_record', status: null, source: 'applications', verifiedAt: new Date().toISOString() }; },
      download: async () => [],
    };
    const live = await getJobPacket(x.db, { jobId: firstId, freshness: 'live', includeDocuments: true }, deps);
    assert.equal(live.freshness.actual, 'live');
    assert.equal(live.documents.files[0].extraction.sha256, 'abc123');
    assert.ok(live.documents.files[0].extraction.excerpt.text.length <= 1200);
    assert.equal(live.description.truncated, true);
    const cached = await getJobPacket(x.db, { jobId: firstId, freshness: 'cache', includeDocuments: true }, deps);
    assert.equal(cached.freshness.actual, 'cache');
    assert.equal(cached.documents.files[0].extraction.evidenceRef, 'document:abc123');
    const automatic = await getJobPacket(x.db, { jobId: firstId, freshness: 'auto' }, deps);
    assert.equal(automatic.freshness.actual, 'cache');
    assert.deepEqual([details, attachments, applications], [1, 1, 1]);
    x.db.prepare('UPDATE job_packets SET fetched_at=? WHERE job_id=?').run('2020-01-01T00:00:00.000Z', firstId);
    const stale = await getJobPacket(x.db, { jobId: firstId, freshness: 'auto' }, deps);
    assert.equal(stale.freshness.actual, 'live');
    assert.deepEqual([details, attachments, applications], [2, 2, 2]);
  } finally { x.done(); }
});

test('live packet reports inaccessible attachments without claiming verified documents', async () => {
  const x = fixture();
  try {
    saveBundle(x.db, bundle([job(firstId)]), [job(firstId)]);
    const result = await getJobPacket(x.db, { jobId: firstId, freshness: 'live', includeDocuments: true }, {
      getDetails: async () => ({ id: firstId, title: 'Engineer' }),
      getAttachments: async () => { throw new ApiError('ACCESS_DENIED', 'Denied', 403); },
      getApplication: async () => ({ state: 'no_record', status: null }),
    });
    assert.equal(result.documents.state, 'unauthorized');
    assert.equal(result.documents.code, 'ACCESS_DENIED');
    assert.equal(result.freshness.actual, 'live');
  } finally { x.done(); }
});
