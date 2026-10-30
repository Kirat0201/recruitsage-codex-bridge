import { authManager } from './auth.mjs';
const API = 'https://api.recruit.thapar.edu';
const RETRIES = 3;
export class ApiError extends Error {
  constructor(code, message, status) { super(message); this.name = 'ApiError'; this.code = code; this.status = status; }
}

export function apiUrl(route, query = {}) {
  if (!/^\/(rest\/v1\/(rpc\/[a-z_]+|[a-z_]+)|storage\/v1\/object\/sign\/job_documents\/.+)$/.test(route) || route.includes('..') || route.includes('\\')) {
    throw new ApiError('UNSAFE_PATH', 'Unsupported API path');
  }
  const url = new URL(route, API);
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  return url;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function request(method, route, { query, body, binary = false, maxBytes = 20 * 1024 * 1024, fetcher = fetch, auth = authManager } = {}) {
  let { key, accessToken } = await auth.valid();
  const url = apiUrl(route, query);
  let authRetried = false;
  for (let attempt = 0; attempt < RETRIES;) {
    let response;
    try {
      const headers = { apikey: key, Authorization: `Bearer ${accessToken}`, Accept: binary ? '*/*' : 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      response = await fetcher(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000), redirect: 'error' });
    } catch (error) {
      if (++attempt < RETRIES && error?.name !== 'AbortError') { await delay(300 * 2 ** (attempt - 1)); continue; }
      throw new ApiError('NETWORK', 'RecruitSage request failed or timed out');
    }
    if (response.status === 401) {
      if (authRetried) throw new ApiError('AUTH_EXPIRED', 'RecruitSage rejected the refreshed session', 401);
      const refreshed = await auth.refresh(accessToken);
      ({ key, accessToken } = refreshed);
      authRetried = true;
      continue;
    }
    if (response.status === 403) throw new ApiError('ACCESS_DENIED', 'RecruitSage denied this account access to the requested resource', 403);
    if ((response.status === 429 || response.status >= 500) && ++attempt < RETRIES) {
      const seconds = Number(response.headers.get('retry-after'));
      await delay(Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 5000) : 300 * 2 ** (attempt - 1));
      continue;
    }
    if (!response.ok) throw new ApiError('HTTP_ERROR', `RecruitSage returned HTTP ${response.status} for ${method} ${url.pathname}`, response.status);
    if (!binary) {
      try { return await response.json(); } catch { throw new ApiError('INVALID_JSON', 'RecruitSage returned invalid JSON'); }
    }
    if (Number(response.headers.get('content-length')) > maxBytes) throw new ApiError('TOO_LARGE', 'Attachment exceeds size limit');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) { await response.body.cancel().catch(() => {}); throw new ApiError('TOO_LARGE', 'Attachment exceeds size limit'); }
      chunks.push(Buffer.from(chunk));
    }
    return { bytes: Buffer.concat(chunks), mime: response.headers.get('content-type') || '' };
  }
  throw new ApiError('RETRY_EXHAUSTED', 'RecruitSage request retries exhausted');
}

export const rpc = (name, body, options) => request('POST', `/rest/v1/rpc/${name}`, { ...options, body });
export const table = (name, query, options) => request('GET', `/rest/v1/${name}`, { ...options, query });

export async function invokeEdgeFunction(name, body, { fetcher = fetch, auth = authManager } = {}) {
  if (name !== 'submit-job-application') throw new ApiError('UNSAFE_PATH', 'Unsupported Edge Function');
  let { key, accessToken } = await auth.valid();
  let refreshed = false;
  for (;;) {
    let response;
    try {
      response = await fetcher(`${API}/functions/v1/${name}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { apikey: key, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
    } catch { throw new ApiError('SUBMISSION_UNKNOWN', 'Application request outcome is unknown; verify My Applications before retrying'); }
    if (response.status === 401 && !refreshed) {
      ({ key, accessToken } = await auth.refresh(accessToken));
      refreshed = true;
      continue;
    }
    let data = null;
    try { data = await response.json(); } catch { /* handled below */ }
    if (!response.ok) {
      const code = response.status === 409 ? 'ALREADY_APPLIED' : response.status === 403 ? 'APPLICATION_REJECTED' : 'APPLICATION_FAILED';
      const message = typeof data?.error === 'string' ? data.error.slice(0, 500) : `RecruitSage rejected the application (HTTP ${response.status})`;
      const error = new ApiError(code, message, response.status);
      error.reasons = Array.isArray(data?.reasons) ? data.reasons.map(String).slice(0, 10) : [];
      throw error;
    }
    if (!data || typeof data !== 'object') throw new ApiError('APPLICATION_SCHEMA', 'RecruitSage returned an invalid application response');
    return data;
  }
}

export async function downloadObject(filePath, options = {}) {
  if (typeof filePath !== 'string' || !filePath || filePath.startsWith('/') || filePath.split('/').some(s => !s || s === '.' || s === '..') || /[\\?#]/.test(filePath)) throw new ApiError('UNSAFE_PATH', 'Unsafe attachment path');
  const route = `/storage/v1/object/sign/job_documents/${filePath.split('/').map(encodeURIComponent).join('/')}`;
  const signed = await request('POST', route, { ...options, body: { expiresIn: 300 } });
  if (typeof signed?.signedURL !== 'string') throw new ApiError('INVALID_RESPONSE', 'Storage did not return a signed URL');
  const relative = signed.signedURL.startsWith('/object/sign/') ? `/storage/v1${signed.signedURL}` : signed.signedURL;
  const url = new URL(relative, API);
  if (url.origin !== API || !url.pathname.startsWith('/storage/v1/object/sign/job_documents/')) throw new ApiError('UNSAFE_URL', 'Storage returned an unexpected download URL');
  // Signed links have their own short-lived token. Do not expose the URL or log it.
  const fetcher = options.fetcher || fetch;
  const response = await fetcher(url, { signal: AbortSignal.timeout(45000), redirect: 'error' });
  if (!response.ok) throw new ApiError('DOWNLOAD_FAILED', `Attachment download returned HTTP ${response.status}`, response.status);
  const maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > maxBytes) throw new ApiError('TOO_LARGE', 'Attachment exceeds size limit');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > maxBytes) { await response.body.cancel().catch(() => {}); throw new ApiError('TOO_LARGE', 'Attachment exceeds size limit'); } chunks.push(Buffer.from(chunk)); }
  return { bytes: Buffer.concat(chunks), mime: response.headers.get('content-type') || '' };
}
