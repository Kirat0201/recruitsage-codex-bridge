import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AuthManager } from '../src/auth.mjs';
import { request } from '../src/http.mjs';

const now = 1_800_000_000_000;
const token = expiry => `header.${Buffer.from(JSON.stringify({ exp: Math.floor(expiry / 1000), email: 'student@example.edu' })).toString('base64url')}.signature`;
function fixture(fetcher, accessExpiry = now + 30_000) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'rs-auth-'));
  const file = path.join(directory, 'session.json');
  const env = { RS_ANON_KEY: 'private-key', RS_ACCESS_TOKEN: token(accessExpiry), RS_REFRESH_TOKEN: 'private-refresh' };
  const manager = new AuthManager({ file, envFile: null, env, fetcher, now: () => now });
  return { directory, file, env, manager, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
const successfulRefresh = () => new Response(JSON.stringify({ access_token: token(now + 3_600_000), refresh_token: 'rotated-refresh' }), { status: 200 });

test('proactive refresh persists rotated credentials privately', async () => {
  let calls = 0; const x = fixture(async () => { calls++; return successfulRefresh(); });
  try {
    const session = await x.manager.valid();
    assert.equal(calls, 1); assert.equal(session.refreshToken, 'rotated-refresh');
    assert.equal(statSync(x.file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(x.file, 'utf8')).refreshToken, 'rotated-refresh');
    assert.equal((await x.manager.valid()).accessToken, session.accessToken);
    assert.equal(calls, 1);
  } finally { x.cleanup(); }
});

test('failed refresh does not overwrite the prior session or expose secrets', async () => {
  const x = fixture(async () => new Response(JSON.stringify({ msg: 'private-refresh' }), { status: 400 }));
  try {
    await assert.rejects(x.manager.valid(), error => { assert.equal(error.code, 'AUTH_REFRESH_FAILED'); assert.doesNotMatch(error.message, /private-refresh/); return true; });
    assert.throws(() => readFileSync(x.file), { code: 'ENOENT' });
  } finally { x.cleanup(); }
});

test('already-used refresh token is reported precisely and preserves the saved session', async () => {
  const x = fixture(async () => new Response(JSON.stringify({ error_code: 'refresh_token_already_used', msg: 'private-refresh' }), { status: 400 }));
  try {
    writeFileSync(x.file, JSON.stringify({ accessToken: x.env.RS_ACCESS_TOKEN, refreshToken: 'private-refresh' }), { mode: 0o600 });
    const before = readFileSync(x.file, 'utf8');
    await assert.rejects(x.manager.valid(), error => {
      assert.equal(error.code, 'AUTH_REFRESH_ALREADY_USED');
      assert.doesNotMatch(error.message, /private-refresh/);
      return true;
    });
    assert.equal(readFileSync(x.file, 'utf8'), before);
  } finally { x.cleanup(); }
});

test('one 401 refreshes and retries exactly once', async () => {
  let refreshes = 0, apiCalls = 0;
  const x = fixture(async (url, init) => {
    if (String(url).includes('/auth/v1/token')) { refreshes++; return successfulRefresh(); }
    apiCalls++;
    return apiCalls === 1 ? new Response('', { status: 401 }) : new Response(JSON.stringify({ ok: true }), { status: 200 });
  }, now + 3_600_000);
  try {
    const result = await request('GET', '/rest/v1/jobs_posted', { auth: x.manager, fetcher: x.manager.fetcher });
    assert.deepEqual(result, { ok: true }); assert.equal(refreshes, 1); assert.equal(apiCalls, 2);
  } finally { x.cleanup(); }
});

test('a second 401 stops after one refresh and retry', async () => {
  let refreshes = 0, apiCalls = 0;
  const fetcher = async url => {
    if (String(url).includes('/auth/v1/token')) { refreshes++; return successfulRefresh(); }
    apiCalls++; return new Response('', { status: 401 });
  };
  const x = fixture(fetcher, now + 3_600_000);
  try {
    await assert.rejects(request('GET', '/rest/v1/jobs_posted', { auth: x.manager, fetcher }), { code: 'AUTH_EXPIRED' });
    assert.equal(refreshes, 1); assert.equal(apiCalls, 2);
  } finally { x.cleanup(); }
});

test('bootstrap rotates and saves a supplied local refresh token', async () => {
  let supplied;
  const x = fixture(async (_url, init) => {
    supplied = JSON.parse(init.body).refresh_token;
    return successfulRefresh();
  });
  try {
    await x.manager.bootstrap('one-time-refresh');
    assert.equal(supplied, 'one-time-refresh');
    assert.equal((await x.manager.current()).refreshToken, 'rotated-refresh');
    assert.equal(statSync(x.file).mode & 0o777, 0o600);
  } finally { x.cleanup(); }
});

test('simultaneous expiry requests share one refresh, including across manager instances', async () => {
  let refreshes = 0;
  const fetcher = async () => { refreshes++; await new Promise(resolve => setTimeout(resolve, 30)); return successfulRefresh(); };
  const x = fixture(fetcher);
  const second = new AuthManager({ file: x.file, envFile: null, env: x.env, fetcher, now: () => now });
  try {
    const values = await Promise.all([x.manager.valid(), x.manager.valid(), second.valid()]);
    assert.equal(refreshes, 1); assert.ok(values.every(v => v.refreshToken === 'rotated-refresh'));
  } finally { x.cleanup(); }
});

test('long-lived MCP process sees a newly updated .env without restart', async () => {
  const x = fixture(async () => { throw new Error('refresh not needed'); });
  const envFile = path.join(x.directory, '.env');
  const manager = new AuthManager({ file: x.file, envFile, env: {}, now: () => now });
  try {
    writeFileSync(envFile, `RS_ANON_KEY=private-key\nRS_ACCESS_TOKEN=${token(now + 3_600_000)}\n`, { mode: 0o600 });
    const first = (await manager.valid()).accessToken;
    writeFileSync(envFile, `RS_ANON_KEY=private-key\nRS_ACCESS_TOKEN=${token(now + 7_200_000)}\n`, { mode: 0o600 });
    assert.notEqual((await manager.valid()).accessToken, first);
  } finally { x.cleanup(); }
});

test('newer explicit .env token supersedes an expired saved session without reusing its refresh token', async () => {
  const x = fixture(async () => { throw new Error('refresh not needed'); });
  const envFile = path.join(x.directory, '.env');
  const manager = new AuthManager({ file: x.file, envFile, env: {}, now: () => now });
  try {
    writeFileSync(x.file, JSON.stringify({ accessToken: token(now - 1000), refreshToken: 'old-refresh' }), { mode: 0o600 });
    writeFileSync(envFile, `RS_ANON_KEY=private-key\nRS_ACCESS_TOKEN=${token(now + 3_600_000)}\n`, { mode: 0o600 });
    const current = await manager.valid();
    assert.equal(current.accessToken, token(now + 3_600_000));
    assert.equal(current.refreshToken, undefined);
  } finally { x.cleanup(); }
});
