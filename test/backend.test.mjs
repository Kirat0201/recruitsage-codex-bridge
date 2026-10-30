import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fetchBundle, normalize, syncJobs, listAppliedJobs, listAvailableJobs } from '../src/jobs.mjs';
import { openStore, cachedJob } from '../src/store.mjs';
import { request, ApiError } from '../src/http.mjs';
import { AuthManager } from '../src/auth.mjs';
import { extractDocument } from '../src/parse.mjs';

const id1 = '11111111-1111-4111-8111-111111111111';
const id2 = '22222222-2222-4222-8222-222222222222';
const first = { mappings: [{ job_id: id1, jobs_posted: { title: 'Engineer', company_id: 'c1' } }], companies: [{ id: 'c1', name: 'Acme' }], applicationRows: [{ job_id: id1, status: 'applied' }], totalJobs: 2, revision: 4, nextCursor: { createdAt: '2026-01-01', jobId: id1, revision: 4 } };
const second = { mappings: [{ job_id: id2, jobs_posted: { title: 'Analyst', company_id: 'c1' } }], companies: [], applicationRows: [], totalJobs: 2, revision: 4, nextCursor: null };

test('paginates, normalizes, stores and avoids a redundant recent sync', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rs-test-')); const db = openStore(path.join(dir, 'jobs.sqlite'));
  let calls = 0;
  const requestRpc = async (name, body) => { calls++; if (name === 'batch_check_job_eligibility_cached') return body.p_job_ids.map(job_id => ({ job_id, result: { eligible: job_id === id2, closed: false, reasons: [] } })); assert.equal(body.p_limit, calls === 1 ? 50 : 150); return calls === 1 ? first : second; };
  try {
    const result = await syncJobs(db, { requestRpc, email: 'test@example.com' });
    assert.equal(result.stored, 2); assert.equal(result.requests, 3);
    assert.equal(cachedJob(db, id1).company, 'Acme');
    assert.equal(listAppliedJobs(db).total, 1);
    assert.equal((await syncJobs(db, { requestRpc, email: 'test@example.com' })).requests, 0); assert.equal(calls, 3);
    assert.equal(listAvailableJobs(db).total, 1);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('incomplete pagination fails instead of silently caching a partial list', async () => {
  await assert.rejects(fetchBundle({ requestRpc: async () => ({ ...first, nextCursor: null }) }), { code: 'INCOMPLETE_PAGE' });
});

test('403 is permission denied and never triggers a refresh', async () => {
  const auth = { valid: async () => ({ key: 'private-key', accessToken: 'private-token' }), refresh: () => { throw new Error('must not refresh'); } };
  await assert.rejects(request('POST', '/rest/v1/rpc/get_student_job_bundle_page', { auth, body: { p_limit: 1 }, fetcher: async () => new Response('', { status: 403 }) }), error => {
    assert.equal(error.code, 'ACCESS_DENIED'); assert.doesNotMatch(error.message, /private/); return true;
  });
});

test('a second forced sync refreshes an expiring access token and keeps SQLite data', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rs-sync-auth-'));
  const db = openStore(path.join(dir, 'jobs.sqlite'));
  const jwt = expiry => `header.${Buffer.from(JSON.stringify({ exp: Math.floor(expiry / 1000) })).toString('base64url')}.signature`;
  let now = 1_800_000_000_000, refreshes = 0, apiCalls = 0;
  const fetcher = async (url, init) => {
    if (String(url).includes('/auth/v1/token')) {
      refreshes++;
      assert.equal(JSON.parse(init.body).refresh_token, 'initial-refresh');
      return new Response(JSON.stringify({ access_token: jwt(now + 3_600_000), refresh_token: 'rotated-refresh' }));
    }
    apiCalls++;
    if (String(url).includes('batch_check_job_eligibility_cached')) {
      return new Response(JSON.stringify([{ job_id: id1, result: { eligible: true, closed: false, reasons: [] } }]));
    }
    return new Response(JSON.stringify({ ...first, mappings: [first.mappings[0]], applicationRows: [], totalJobs: 1, nextCursor: null }));
  };
  const auth = new AuthManager({ file: path.join(dir, 'session.json'), envFile: null, env: { RS_ANON_KEY: 'private-key', RS_ACCESS_TOKEN: jwt(now + 120_000), RS_REFRESH_TOKEN: 'initial-refresh' }, fetcher, now: () => now });
  const requestRpc = (name, body) => request('POST', `/rest/v1/rpc/${name}`, { body, auth, fetcher });
  try {
    assert.equal((await syncJobs(db, { force: true, requestRpc, email: 'student@example.edu' })).stored, 1);
    now += 90_000;
    assert.equal((await syncJobs(db, { force: true, requestRpc, email: 'student@example.edu' })).stored, 1);
    assert.equal(refreshes, 1); assert.equal(apiCalls, 4);
    assert.equal(cachedJob(db, id1).title, 'Engineer');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('text extraction is local and rejects an invalid PDF', async () => {
  assert.equal((await extractDocument(Buffer.from('hello'), 'readme.txt')).text, 'hello');
  await assert.rejects(extractDocument(Buffer.from('not pdf'), 'jd.pdf'), { code: 'INVALID_DOCUMENT' });
  await assert.rejects(extractDocument(Buffer.from('hello'), 'readme.txt', 'application/pdf'), { code: 'INVALID_DOCUMENT' });
});

function zipFixture(filename = 'notes.txt', contents = 'hello from zip') {
  const name = Buffer.from(filename), body = Buffer.from(contents);
  let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  crc = (crc ^ 0xffffffff) >>> 0;
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(body.length, 18);
  header.writeUInt32LE(body.length, 22);
  header.writeUInt16LE(name.length, 26);
  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50, 0);
  directory.writeUInt16LE(0, 8);
  directory.writeUInt16LE(0, 10);
  directory.writeUInt32LE(crc, 16);
  directory.writeUInt32LE(body.length, 20);
  directory.writeUInt32LE(body.length, 24);
  directory.writeUInt16LE(name.length, 28);
  const directoryOffset = header.length + name.length + body.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length + name.length, 12);
  end.writeUInt32LE(directoryOffset, 16);
  return Buffer.concat([header, name, body, directory, name, end]);
}

test('ZIP text extraction reads a bounded local member without external tools', async () => {
  const result = await extractDocument(zipFixture(), 'bundle.zip');
  assert.match(result.text, /hello from zip/);
  assert.equal(result.sources[0].member, 'notes.txt');
});

test('ZIP extraction rejects traversal and malformed archives', async () => {
  await assert.rejects(extractDocument(zipFixture('../secret.txt'), 'bundle.zip'), { code: 'UNSAFE_ZIP' });
  const incomplete = zipFixture().subarray(0, 20);
  await assert.rejects(extractDocument(incomplete, 'bundle.zip'), { code: 'INVALID_ZIP' });
  const bomb = zipFixture();
  bomb.writeUInt32LE(11 * 1024 * 1024, 30 + 'notes.txt'.length + 'hello from zip'.length + 24);
  await assert.rejects(extractDocument(bomb, 'bundle.zip'), { code: 'ZIP_LIMIT' });
  const corrupt = zipFixture();
  corrupt[30 + 'notes.txt'.length] ^= 1;
  await assert.rejects(extractDocument(corrupt, 'bundle.zip'), { code: 'CORRUPT_DOCUMENT' });
  await assert.rejects(extractDocument(zipFixture(), 'wrong.docx'), { code: 'INVALID_DOCUMENT' });
});
