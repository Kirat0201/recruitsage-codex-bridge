import { openStore } from './store.mjs';
import { gmailAuth } from './gmail-auth.mjs';
import { configureGmailAccount } from './gmail-store.mjs';
import { getPlacementDocket, syncGmail } from './gmail-sync.mjs';

const [command, accountId, ...args] = process.argv.slice(2);
const db = openStore();
try {
  let result;
  switch (command) {
    case 'configure': {
      await gmailAuth.stored(accountId);
      const [placementQuery, ...filters] = args;
      result = configureGmailAccount(db, { accountId, placementQuery,
        subjectTerms: filters.filter(value => !value.startsWith('@')),
        senderDomains: filters.filter(value => value.startsWith('@')).map(value => value.slice(1)) });
      break;
    }
    case 'sync':
      result = await syncGmail(db, { accountId, freshness: args.includes('--live') ? 'live' : 'auto' });
      break;
    case 'docket':
      result = await getPlacementDocket(db, { accountId, freshness: args.includes('--live') ? 'live' : 'cache', limit: 10 });
      break;
    default: throw new Error('Usage: node src/gmail-cli.mjs configure ACCOUNT_EMAIL GMAIL_QUERY SUBJECT_TERM [@SENDER_DOMAIN] | sync ACCOUNT_EMAIL [--live] | docket ACCOUNT_EMAIL [--live]');
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ code: error.code ?? 'ERROR', message: error.message }));
  process.exitCode = 1;
} finally { db.close(); }
