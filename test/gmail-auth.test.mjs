import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GmailAuth } from '../src/gmail-auth.mjs';
import { GmailClient } from '../src/gmail-http.mjs';

function fixture(fetcher) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rs-gmail-auth-'));
  const clientFile = path.join(dir, 'oauth-client.json');
  writeFileSync(clientFile, JSON.stringify({ installed: { client_id: 'test.apps.googleusercontent.com', client_secret: 'local-test-secret' } }), { mode: 0o600 });
  const tokenDir = path.join(dir, 'tokens'); mkdirSync(tokenDir, { mode: 0o700 });
  let now = 1_800_000_000_000;
  const auth = new GmailAuth({ clientFile, tokenDir, fetcher, now: () => now });
  return { dir, tokenDir, auth, setNow(value) { now = value; }, done() { rmSync(dir, { recursive: true, force: true }); } };
}

test('Desktop PKCE consent, account isolation and automatic token renewal', async () => {
  let exchanges = 0, refreshes = 0;
  const fetcher = async (url, init) => {
    if (String(url).includes('/token')) {
      const fields = new URLSearchParams(init.body);
      if (fields.get('grant_type') === 'authorization_code') {
        exchanges++; assert.ok(fields.get('code_verifier')); assert.equal(fields.get('code'), 'test-code');
        return new Response(JSON.stringify({ access_token: 'initial-access', refresh_token: 'private-refresh', expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/gmail.readonly' }));
      }
      refreshes++; assert.equal(fields.get('refresh_token'), 'private-refresh');
      return new Response(JSON.stringify({ access_token: 'renewed-access', expires_in: 3600 }));
    }
    assert.ok(String(url).endsWith('/users/me/profile'));
    assert.equal(init.headers.authorization, 'Bearer initial-access');
    return new Response(JSON.stringify({ emailAddress: 'Student@Example.edu', historyId: '100' }));
  };
  const x = fixture(fetcher);
  try {
    const redirectUri = 'http://127.0.0.1:55555/oauth/callback';
    const start = await x.auth.beginAuthorization(redirectUri);
    const url = new URL(start.url);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly');
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.ok(url.searchParams.get('state'));
    assert.ok(start.verifier.length >= 43);
    const saved = await x.auth.completeAuthorization({ code: 'test-code', verifier: start.verifier, redirectUri });
    assert.equal(saved.accountId, 'student@example.edu');
    assert.equal(saved.historyId, '100');
    const files = (await import('node:fs')).readdirSync(x.tokenDir);
    assert.equal(files.length, 1);
    assert.equal(statSync(path.join(x.tokenDir, files[0])).mode & 0o777, 0o600);
    assert.equal((await x.auth.accessToken(saved.accountId)), 'initial-access');
    x.setNow(1_800_003_550_000);
    assert.equal((await x.auth.accessToken(saved.accountId)), 'renewed-access');
    assert.equal(refreshes, 1); assert.equal(exchanges, 1);
    await assert.rejects(x.auth.stored('other@example.edu'), { code: 'GMAIL_AUTH_REQUIRED' });
    assert.doesNotMatch(readFileSync(path.join(x.tokenDir, files[0]), 'utf8'), /test-code/);
  } finally { x.done(); }
});

test('OAuth denial or missing scope never persists a Gmail session', async () => {
  const x = fixture(async url => String(url).includes('/token')
    ? new Response(JSON.stringify({ access_token: 'private', refresh_token: 'private', expires_in: 3600, scope: 'openid' }))
    : new Response('{}'));
  try {
    await assert.rejects(x.auth.completeAuthorization({ code: 'test-code', verifier: 'x'.repeat(48), redirectUri: 'http://127.0.0.1:55555/oauth/callback' }), { code: 'GMAIL_SCOPE_MISSING' });
    assert.equal((await import('node:fs')).readdirSync(x.tokenDir).length, 0);
  } finally { x.done(); }
});

test('Gmail HTTP renews once after 401, retries 429, and never exposes tokens in errors', async () => {
  let refreshes = 0, calls = 0;
  const auth = { accessToken: async () => 'secret-access', refresh: async () => { refreshes++; return { accessToken: 'secret-new' }; } };
  const client = new GmailClient({ auth, fetcher: async (_url, init) => {
    calls++;
    if (calls === 1) return new Response('', { status: 401 });
    if (calls === 2) { assert.equal(init.headers.authorization, 'Bearer secret-new'); return new Response('', { status: 429 }); }
    return new Response(JSON.stringify({ historyId: '42' }));
  } });
  const result = await client.profile('student@example.edu');
  assert.equal(result.historyId, '42'); assert.equal(refreshes, 1); assert.equal(calls, 3);
  const denied = new GmailClient({ auth, fetcher: async () => new Response('secret-access', { status: 403 }) });
  await assert.rejects(denied.profile('student@example.edu'), error => {
    assert.equal(error.code, 'GMAIL_PERMISSION_DENIED'); assert.doesNotMatch(error.message, /secret/); return true;
  });
});

test('concurrent Gmail clients share renewal and rejected renewal preserves saved credentials', async () => {
  let refreshes = 0, rejectRefresh = false;
  const fetcher = async (url, init) => {
    if (String(url).includes('/token')) {
      const fields = new URLSearchParams(init.body);
      if (fields.get('grant_type') === 'authorization_code') return new Response(JSON.stringify({
        access_token: 'first-access', refresh_token: 'first-refresh', expires_in: 30,
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
      }));
      refreshes++;
      await new Promise(resolve => setTimeout(resolve, 20));
      return rejectRefresh ? new Response('{}', { status: 400 })
        : new Response(JSON.stringify({ access_token: 'second-access', refresh_token: 'second-refresh', expires_in: 3600 }));
    }
    return new Response(JSON.stringify({ emailAddress: 'student@example.edu', historyId: '100' }));
  };
  const x = fixture(fetcher);
  try {
    await x.auth.completeAuthorization({ code: 'code', verifier: 'x'.repeat(48), redirectUri: 'http://127.0.0.1:55555/oauth/callback' });
    const other = new GmailAuth({ clientFile: x.auth.clientFile, tokenDir: x.tokenDir, fetcher, now: () => 1_800_000_000_000 });
    const tokens = await Promise.all([x.auth.accessToken('student@example.edu'), other.accessToken('student@example.edu')]);
    assert.deepEqual(tokens, ['second-access', 'second-access']);
    assert.equal(refreshes, 1);
    x.setNow(1_800_003_550_000);
    rejectRefresh = true;
    await assert.rejects(x.auth.accessToken('student@example.edu'), { code: 'GMAIL_TOKEN_REJECTED' });
    assert.equal((await x.auth.stored('student@example.edu')).refreshToken, 'second-refresh');
  } finally { x.done(); }
});

test('Gmail attachment route accepts long opaque IDs and rejects unsafe path characters', async () => {
  let called = 0;
  const auth = { accessToken: async () => 'test-access' };
  const client = new GmailClient({ auth, fetcher: async url => {
    called++; assert.match(String(url), /\/messages\/msg1\/attachments\//);
    return new Response(JSON.stringify({ size: 3, data: 'YWJj' }));
  } });
  assert.equal((await client.getAttachment('student@example.edu', 'msg1', 'a'.repeat(404))).size, 3);
  assert.equal(called, 1);
  assert.throws(() => client.getAttachment('student@example.edu', 'msg1', '../bad'), { code: 'INVALID_ATTACHMENT_ID' });
});
