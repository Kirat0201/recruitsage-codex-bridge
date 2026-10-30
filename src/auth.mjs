import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_AUTH_FILE = path.join(ROOT, '.env');
const DEFAULT_SESSION_FILE = path.join(ROOT, 'data/auth/session.json');
const REFRESH_URL = 'https://api.recruit.thapar.edu/auth/v1/token?grant_type=refresh_token';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export class AuthError extends Error {
  constructor(code, message) { super(message); this.name = 'AuthError'; this.code = code; }
}

export function loadLocalAuth(file = DEFAULT_AUTH_FILE) {
  const values = readLocalAuth(file);
  if (!values) return false;
  Object.assign(process.env, values);
  return true;
}

function readLocalAuth(file) {
  if (!file || !existsSync(file)) return null;
  if (statSync(file).mode & 0o077) throw new AuthError('UNSAFE_AUTH_FILE', '.env must be owner-only (chmod 600 .env)');
  const values = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match && ['RS_ANON_KEY', 'RS_ACCESS_TOKEN', 'RS_REFRESH_TOKEN'].includes(match[1])) values[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return values;
}

export function jwtExpiry(token) {
  try {
    const exp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).exp;
    return Number.isSafeInteger(exp) ? exp * 1000 : null;
  } catch { return null; }
}

export class AuthManager {
  constructor({ file = DEFAULT_SESSION_FILE, envFile = DEFAULT_AUTH_FILE, env = process.env, fetcher = fetch, now = () => Date.now() } = {}) {
    this.file = file; this.envFile = envFile; this.env = env; this.fetcher = fetcher; this.now = now; this.inflight = null;
  }

  async current() {
    let saved = null;
    try {
      const handle = await open(this.file, 'r');
      try {
        if ((await handle.stat()).mode & 0o077) throw new AuthError('UNSAFE_AUTH_FILE', 'Session file must be owner-only');
        saved = JSON.parse(await handle.readFile('utf8'));
      } finally { await handle.close(); }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const configured = { ...this.env, ...readLocalAuth(this.envFile) };
    const key = configured.RS_ANON_KEY?.trim();
    const configuredAccess = configured.RS_ACCESS_TOKEN?.trim();
    // An explicit newer local session can recover a process from an expired saved session.
    // Never pair a manually replaced access token with a refresh token from an older session.
    const useConfigured = configuredAccess && jwtExpiry(configuredAccess) > jwtExpiry(saved?.accessToken);
    const accessToken = useConfigured ? configuredAccess : (saved?.accessToken ?? configuredAccess);
    const refreshToken = useConfigured ? configured.RS_REFRESH_TOKEN?.trim() : (saved?.refreshToken ?? configured.RS_REFRESH_TOKEN?.trim());
    if (!key || !accessToken) throw new AuthError('AUTH_REQUIRED', 'Local RecruitSage API key and authorized session are required');
    return { key, accessToken, refreshToken };
  }

  async valid({ leewayMs = 60_000 } = {}) {
    const session = await this.current();
    const expiry = jwtExpiry(session.accessToken);
    if (expiry && expiry <= this.now() + leewayMs) {
      if (!session.refreshToken) throw new AuthError('AUTH_REFRESH_REQUIRED', 'Access token expired; bootstrap a local refresh token once');
      return this.refresh(session.accessToken);
    }
    return session;
  }

  async bootstrap(refreshToken) {
    if (typeof refreshToken !== 'string' || !refreshToken.trim()) throw new AuthError('AUTH_REFRESH_REQUIRED', 'A local refresh token is required');
    const current = await this.current();
    return this.#refreshLocked(current.accessToken, refreshToken.trim());
  }

  async refresh(staleAccessToken) {
    if (this.inflight) return this.inflight;
    this.inflight = this.#refreshLocked(staleAccessToken).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async #refreshLocked(staleAccessToken, suppliedRefreshToken = null) {
    const folder = path.dirname(this.file);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const lockPath = `${this.file}.lock`;
    let lock;
    // Refresh HTTP has a 15-second deadline. Give a different process enough time to
    // finish that request and persist its rotated token before declaring contention.
    for (let attempt = 0; attempt < 250; attempt++) {
      try { lock = await open(lockPath, 'wx', 0o600); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await pause(100);
        const changed = await this.current();
        if (changed.accessToken !== staleAccessToken && jwtExpiry(changed.accessToken) > this.now() + 60_000) return changed;
      }
    }
    if (!lock) throw new AuthError('AUTH_REFRESH_BUSY', 'Another process is refreshing the RecruitSage session');
    try {
      const current = await this.current();
      if (!suppliedRefreshToken && current.accessToken !== staleAccessToken && jwtExpiry(current.accessToken) > this.now() + 60_000) return current;
      const refreshToken = suppliedRefreshToken ?? current.refreshToken;
      if (!refreshToken) throw new AuthError('AUTH_REFRESH_REQUIRED', 'No local refresh token is available');
      let response;
      try {
        response = await this.fetcher(REFRESH_URL, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
          headers: { apikey: current.key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: refreshToken }),
        });
      } catch { throw new AuthError('AUTH_REFRESH_FAILED', 'RecruitSage refresh request failed'); }
      if (!response.ok) {
        let errorCode;
        try {
          const detail = await response.json();
          errorCode = detail?.error_code;
        } catch { /* Keep the HTTP status without exposing an untrusted response body. */ }
        if (errorCode === 'refresh_token_already_used') {
          throw new AuthError('AUTH_REFRESH_ALREADY_USED', 'RecruitSage reports the saved refresh token was already used; bootstrap a new authorized session locally');
        }
        throw new AuthError('AUTH_REFRESH_FAILED', `RecruitSage rejected the refresh session (HTTP ${response.status})`);
      }
      let data;
      try { data = await response.json(); } catch { throw new AuthError('AUTH_REFRESH_FAILED', 'RecruitSage returned invalid refresh JSON'); }
      if (typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string' || !jwtExpiry(data.access_token)) {
        throw new AuthError('AUTH_REFRESH_FAILED', 'RecruitSage returned an incomplete refresh session');
      }
      const session = { accessToken: data.access_token, refreshToken: data.refresh_token };
      const temporary = `${this.file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(session)); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, this.file);
      } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
      return { key: current.key, ...session };
    } finally {
      await lock.close();
      await unlink(lockPath).catch(() => {});
    }
  }
}

export const authManager = new AuthManager();
