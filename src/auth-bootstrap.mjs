import { loadLocalAuth, authManager, jwtExpiry } from './auth.mjs';

if (process.stdin.isTTY) {
  console.error('Pipe a refresh token through stdin; do not type it into a command argument or chat.');
  process.exit(1);
}
try {
  loadLocalAuth();
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk.toString('utf8');
    if (input.length > 1024) throw new Error('Refresh token input is too large');
  }
  const session = await authManager.bootstrap(input.trim());
  console.log(JSON.stringify({ refreshed: true, persistedLocally: true, expiresAt: new Date(jwtExpiry(session.accessToken)).toISOString() }));
} catch (error) {
  console.error(JSON.stringify({ error: error.code ?? 'ERROR', message: error.message }));
  process.exitCode = 1;
}
