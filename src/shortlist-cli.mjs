import { openStore } from './store.mjs';
import { configureIdentityFromGmail, saveStudentIdentity } from './student-identity.mjs';
import { analyzeShortlistEmail, getShortlistHistory } from './shortlist.mjs';

const [command, accountId, jobId, messageId] = process.argv.slice(2);
const db = openStore();
try {
  let result;
  if (command === 'identity') result = await configureIdentityFromGmail(accountId);
  else if (command === 'identity-import') {
    if (process.stdin.isTTY) throw new Error('Pipe a private identity JSON file through stdin');
    let input = '';
    for await (const chunk of process.stdin) { input += chunk.toString('utf8'); if (input.length > 4096) throw new Error('Identity input is too large'); }
    const profile = JSON.parse(input);
    if (profile.accountId?.toLowerCase() !== accountId?.toLowerCase()) throw new Error('Identity account mismatch');
    result = await saveStudentIdentity(profile);
  }
  else if (command === 'analyze') result = await analyzeShortlistEmail(db, { accountId, jobId, messageId });
  else if (command === 'history') result = getShortlistHistory(db, { accountId, jobId });
  else throw new Error('Usage: identity ACCOUNT_EMAIL | identity-import ACCOUNT_EMAIL < private-profile.json | analyze ACCOUNT_EMAIL JOB_ID MESSAGE_ID | history ACCOUNT_EMAIL JOB_ID');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ code: error.code ?? 'ERROR', message: error.message }));
  process.exitCode = 1;
} finally { db.close(); }
