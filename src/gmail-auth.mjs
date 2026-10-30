import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './store.mjs';

const CLIENT_FILE = path.join(DATA_DIR, 'gmail/oauth-client.json');
const TOKEN_DIR = path.join(DATA_DIR, 'gmail/tokens');
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export class GmailAuthError extends Error {
  constructor(code, message) { super(message); this.name = 'GmailAuthError'; this.code = code; }
}
export function normalizeAccountId(value) {
  if (typeof value !== 'string' || !/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(value)) throw new GmailAuthError('INVALID_ACCOUNT_ID', 'Expected a Gmail account email address');
  return value.toLowerCase();
}
function tokenPath(folder, accountId) {
  return path.join(folder, `${createHash('sha256').update(normalizeAccountId(accountId)).digest('hex')}.json`);
}
async function readPrivateJson(file, missingCode) {
  let handle;
  try {
    handle = await open(file, 'r');
    if ((await handle.stat()).mode & 0o077) throw new GmailAuthError('UNSAFE_GMAIL_FILE', 'Gmail credential file must be owner-only');
    return JSON.parse(await handle.readFile('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new GmailAuthError(missingCode, 'Gmail OAuth configuration or account authorization is missing');
    if (error instanceof SyntaxError) throw new GmailAuthError('INVALID_GMAIL_FILE', 'Gmail credential JSON is invalid');
    throw error;
  } finally { await handle?.close(); }
}
async function savePrivateJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}
function assertLoopback(uri) {
  const parsed = new URL(uri);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/oauth/callback') throw new GmailAuthError('INVALID_REDIRECT', 'OAuth redirect must use the local loopback callback');
}

export class GmailAuth {
  constructor({ clientFile = CLIENT_FILE, tokenDir = TOKEN_DIR, fetcher = fetch, now = () => Date.now() } = {}) {
    this.clientFile = clientFile; this.tokenDir = tokenDir; this.fetcher = fetcher; this.now = now; this.inflight = new Map();
  }
  async client() {
    const json = await readPrivateJson(this.clientFile, 'GMAIL_CLIENT_REQUIRED');
    const installed = json.installed;
    if (typeof installed?.client_id !== 'string' || !installed.client_id.endsWith('.apps.googleusercontent.com')) throw new GmailAuthError('INVALID_GMAIL_CLIENT', 'Expected a Google OAuth Desktop client JSON');
    return installed;
  }
  async beginAuthorization(redirectUri) {
    assertLoopback(redirectUri);
    const client = await this.client();
    const verifier = randomBytes(48).toString('base64url');
    const state = randomBytes(24).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const url = new URL(AUTH_URL);
    for (const [key, value] of Object.entries({ client_id: client.client_id, redirect_uri: redirectUri, response_type: 'code',
      scope: GMAIL_SCOPE, access_type: 'offline', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256', state })) url.searchParams.set(key, value);
    return { url: url.toString(), state, verifier };
  }
  async #postToken(fields) {
    const client = await this.client();
    const form = new URLSearchParams({ client_id: client.client_id, ...(client.client_secret ? { client_secret: client.client_secret } : {}), ...fields });
    let response;
    try { response = await this.fetcher(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form, redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
    catch { throw new GmailAuthError('GMAIL_TOKEN_NETWORK', 'Google token request failed'); }
    if (!response.ok) throw new GmailAuthError('GMAIL_TOKEN_REJECTED', `Google rejected the token request (HTTP ${response.status})`);
    try { return await response.json(); } catch { throw new GmailAuthError('GMAIL_TOKEN_RESPONSE', 'Google token response was invalid'); }
  }
  async completeAuthorization({ code, verifier, redirectUri }) {
    assertLoopback(redirectUri);
    if (typeof code !== 'string' || !code || typeof verifier !== 'string' || verifier.length < 43) throw new GmailAuthError('INVALID_OAUTH_CODE', 'Authorization code or PKCE verifier is missing');
    const token = await this.#postToken({ code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code' });
    if (typeof token.access_token !== 'string' || typeof token.refresh_token !== 'string' || !token.scope?.split(' ').includes(GMAIL_SCOPE)) throw new GmailAuthError('GMAIL_SCOPE_MISSING', 'Google did not grant offline Gmail read-only access');
    let profileResponse;
    try { profileResponse = await this.fetcher(PROFILE_URL, { headers: { authorization: `Bearer ${token.access_token}` }, redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
    catch { throw new GmailAuthError('GMAIL_PROFILE_NETWORK', 'Gmail profile request failed'); }
    if (!profileResponse.ok) throw new GmailAuthError('GMAIL_PROFILE_REJECTED', `Gmail profile request returned HTTP ${profileResponse.status}`);
    const profile = await profileResponse.json();
    const accountId = normalizeAccountId(profile.emailAddress);
    await savePrivateJson(tokenPath(this.tokenDir, accountId), {
      accountId, accessToken: token.access_token, refreshToken: token.refresh_token,
      expiresAt: this.now() + Number(token.expires_in) * 1000, scope: token.scope,
    });
    return { accountId, historyId: String(profile.historyId ?? '') };
  }
  async stored(accountId) {
    const session = await readPrivateJson(tokenPath(this.tokenDir, accountId), 'GMAIL_AUTH_REQUIRED');
    if (session.accountId !== normalizeAccountId(accountId) || typeof session.refreshToken !== 'string') throw new GmailAuthError('INVALID_GMAIL_SESSION', 'Stored Gmail account session is invalid');
    return session;
  }
  async accessToken(accountId) {
    const session = await this.stored(accountId);
    if (Number(session.expiresAt) > this.now() + 60_000) return session.accessToken;
    return (await this.refresh(accountId, session.accessToken)).accessToken;
  }
  async refresh(accountId, staleAccessToken) {
    accountId = normalizeAccountId(accountId);
    if (this.inflight.has(accountId)) return this.inflight.get(accountId);
    const task = this.#refreshLocked(accountId, staleAccessToken).finally(() => this.inflight.delete(accountId));
    this.inflight.set(accountId, task);
    return task;
  }
  async #refreshLocked(accountId, staleAccessToken) {
    await mkdir(this.tokenDir, { recursive: true, mode: 0o700 });
    const file = tokenPath(this.tokenDir, accountId), lockFile = `${file}.lock`;
    let lock;
    for (let attempt = 0; attempt < 250; attempt++) {
      try { lock = await open(lockFile, 'wx', 0o600); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await wait(100);
        const changed = await this.stored(accountId);
        if (changed.accessToken !== staleAccessToken && changed.expiresAt > this.now() + 60_000) return changed;
      }
    }
    if (!lock) throw new GmailAuthError('GMAIL_REFRESH_BUSY', 'Another process is renewing the Gmail account');
    try {
      const current = await this.stored(accountId);
      if (current.accessToken !== staleAccessToken && current.expiresAt > this.now() + 60_000) return current;
      const token = await this.#postToken({ grant_type: 'refresh_token', refresh_token: current.refreshToken });
      if (typeof token.access_token !== 'string' || !Number.isFinite(Number(token.expires_in))) throw new GmailAuthError('GMAIL_REFRESH_FAILED', 'Google returned an incomplete access token');
      const next = { ...current, accessToken: token.access_token, refreshToken: token.refresh_token ?? current.refreshToken,
        expiresAt: this.now() + Number(token.expires_in) * 1000 };
      await savePrivateJson(file, next);
      return next;
    } finally { await lock.close(); await unlink(lockFile).catch(() => {}); }
  }
}

export const gmailAuth = new GmailAuth();
