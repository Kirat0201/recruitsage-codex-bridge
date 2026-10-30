import { openStore } from './store.mjs';
import { prepareJobMission, getJobMission } from './mission.mjs';

const [command, accountId, jobId, freshness] = process.argv.slice(2);
if (!['prepare', 'show'].includes(command) || !accountId || !jobId) throw Error('Usage: node src/mission-cli.mjs prepare|show ACCOUNT_EMAIL JOB_ID [live|cache]');
const db = openStore();
try {
  const result = command === 'prepare' ? await prepareJobMission(db, { accountId, jobId, freshness: freshness ?? 'live' }) : getJobMission(db, jobId);
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ code: error.code ?? 'ERROR', message: error.message }));
  process.exitCode = 1;
} finally { db.close(); }
