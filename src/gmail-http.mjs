import { gmailAuth, normalizeAccountId } from './gmail-auth.mjs';

const ORIGIN = 'https://gmail.googleapis.com';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ATTACHMENT_ID = /^[A-Za-z0-9_-]{1,4096}$/;
export class GmailApiError extends Error {
  constructor(code, message, status) { super(message); this.name = 'GmailApiError'; this.code = code; this.status = status; }
}

export class GmailClient {
  constructor({ auth = gmailAuth, fetcher = fetch } = {}) { this.auth = auth; this.fetcher = fetcher; }
  async request(accountId, path, query = {}, maxResponseBytes = 4 * 1024 * 1024) {
    accountId = normalizeAccountId(accountId);
    if (!/^\/gmail\/v1\/users\/me\/(profile|messages(?:\/[A-Za-z0-9_-]{1,128}(?:\/attachments\/[A-Za-z0-9_-]{1,4096})?)?|history)$/.test(path)) throw new GmailApiError('UNSAFE_GMAIL_PATH', 'Unsupported Gmail API path');
    const url = new URL(path, ORIGIN);
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    let token = await this.auth.accessToken(accountId);
    let authRetried = false;
    for (let attempt = 0; attempt < 3;) {
      let response;
      try { response = await this.fetcher(url, { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(20_000) }); }
      catch {
        if (++attempt < 3) { await delay(250 * 2 ** (attempt - 1)); continue; }
        throw new GmailApiError('GMAIL_NETWORK', 'Gmail API request failed');
      }
      if (response.status === 401) {
        if (authRetried) throw new GmailApiError('GMAIL_AUTH_EXPIRED', 'Gmail rejected the renewed session', 401);
        token = (await this.auth.refresh(accountId, token)).accessToken;
        authRetried = true; continue;
      }
      if (response.status === 403) throw new GmailApiError('GMAIL_PERMISSION_DENIED', 'Gmail denied read-only access', 403);
      if (response.status === 404) throw new GmailApiError(path.endsWith('/history') ? 'HISTORY_EXPIRED' : 'GMAIL_NOT_FOUND', 'Gmail resource or history cursor is unavailable', 404);
      if ((response.status === 429 || response.status >= 500) && ++attempt < 3) {
        const seconds = Number(response.headers.get('retry-after'));
        await delay(Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 5000) : 250 * 2 ** (attempt - 1));
        continue;
      }
      if (!response.ok) throw new GmailApiError('GMAIL_HTTP_ERROR', `Gmail returned HTTP ${response.status}`, response.status);
      if (Number(response.headers.get('content-length')) > maxResponseBytes) throw new GmailApiError('GMAIL_RESPONSE_TOO_LARGE', 'Gmail response exceeds the local size limit');
      const chunks = []; let size = 0;
      try {
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > maxResponseBytes) throw new GmailApiError('GMAIL_RESPONSE_TOO_LARGE', 'Gmail response exceeds the local size limit');
          chunks.push(Buffer.from(chunk));
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (error) {
        if (error instanceof GmailApiError) throw error;
        throw new GmailApiError('GMAIL_INVALID_JSON', 'Gmail returned invalid JSON');
      }
    }
    throw new GmailApiError('GMAIL_RETRY_EXHAUSTED', 'Gmail retry limit exceeded');
  }
  profile(accountId) { return this.request(accountId, '/gmail/v1/users/me/profile'); }
  listMessages(accountId, { q, pageToken, maxResults = 100 } = {}) {
    return this.request(accountId, '/gmail/v1/users/me/messages', { q, pageToken, maxResults });
  }
  getMessage(accountId, messageId, format = 'full') {
    if (!MESSAGE_ID.test(messageId)) throw new GmailApiError('INVALID_MESSAGE_ID', 'Gmail message ID is invalid');
    if (!['full', 'metadata'].includes(format)) throw new GmailApiError('INVALID_FORMAT', 'Unsupported Gmail message format');
    return this.request(accountId, `/gmail/v1/users/me/messages/${messageId}`, { format });
  }
  getAttachment(accountId, messageId, attachmentId) {
    if (!MESSAGE_ID.test(messageId) || !ATTACHMENT_ID.test(attachmentId)) throw new GmailApiError('INVALID_ATTACHMENT_ID', 'Gmail attachment identity is invalid');
    return this.request(accountId, `/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`, {}, 28 * 1024 * 1024);
  }
  listHistory(accountId, { startHistoryId, pageToken, maxResults = 100 } = {}) {
    if (!/^\d+$/.test(String(startHistoryId ?? ''))) throw new GmailApiError('INVALID_HISTORY_ID', 'Gmail history cursor is invalid');
    return this.request(accountId, '/gmail/v1/users/me/history', { startHistoryId, pageToken, maxResults });
  }
}

export const gmailClient = new GmailClient();
