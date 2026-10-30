import { createServer } from 'node:http';
import { gmailAuth } from './gmail-auth.mjs';

const server = createServer();
let timer;
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const redirectUri = `http://127.0.0.1:${server.address().port}/oauth/callback`;
  const { url, state, verifier } = await gmailAuth.beginAuthorization(redirectUri);
  console.log('Open this URL yourself in a browser, sign in, and approve Gmail read-only access:');
  console.log(url);
  console.log('Waiting for the loopback callback. This CLI does not open a browser.');
  const result = await new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Gmail authorization timed out after five minutes')), 5 * 60_000);
    server.on('request', async (request, response) => {
      try {
        const callback = new URL(request.url, redirectUri);
        if (request.method !== 'GET' || callback.pathname !== '/oauth/callback' || callback.searchParams.get('state') !== state) {
          response.writeHead(400, { 'content-type': 'text/plain' }); response.end('Invalid authorization callback'); return;
        }
        if (callback.searchParams.has('error')) throw new Error('Google authorization was declined or failed');
        const code = callback.searchParams.get('code');
        const account = await gmailAuth.completeAuthorization({ code, verifier, redirectUri });
        response.writeHead(200, { 'content-type': 'text/plain' }); response.end('Gmail authorization saved locally. You may close this page.');
        resolve(account);
      } catch (error) {
        response.writeHead(400, { 'content-type': 'text/plain' }); response.end('Gmail authorization failed. Check the terminal for a redacted error.');
        reject(error);
      }
    });
  });
  console.log(JSON.stringify({ authorized: true, accountId: result.accountId, historyIdPresent: Boolean(result.historyId) }));
} catch (error) {
  console.error(JSON.stringify({ code: error.code ?? 'GMAIL_AUTH_FAILED', message: error.message }));
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  server.close();
}
