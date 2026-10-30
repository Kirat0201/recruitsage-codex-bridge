import { openStore } from './store.mjs';
import { runCareerWorkflow, careerBriefing } from './career-context.mjs';
const [command,accountId,jobId]=process.argv.slice(2);
if (!['sync','briefing'].includes(command)||!accountId) throw Error('Usage: node src/career-cli.mjs sync|briefing ACCOUNT_EMAIL [JOB_ID]');
const db=openStore();
try { const result=command==='sync'?await runCareerWorkflow(db,{accountId}):careerBriefing(db,{accountId,jobId}); console.log(JSON.stringify(result)); }
catch(error){ console.error(JSON.stringify({code:error.code??'ERROR',message:error.message})); process.exitCode=1; }
finally { db.close(); }
