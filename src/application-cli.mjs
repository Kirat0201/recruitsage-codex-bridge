import { readFile } from 'node:fs/promises';
import { openStore } from './store.mjs';
import { prepareJobApplication, submitJobApplication } from './application.mjs';

const [command, first, second, answersFile] = process.argv.slice(2);
const db = openStore();
try {
  let result;
  if (command === 'prepare') {
    let screeningAnswers = [];
    if (answersFile) screeningAnswers = JSON.parse((await readFile(answersFile, 'utf8')).slice(0, 100_000));
    result = await prepareJobApplication(db, { jobId:first, portalResumeId:second || undefined, screeningAnswers });
  } else if (command === 'submit') result = await submitJobApplication(db, { intentId:first, confirmation:second });
  else throw Error('Usage: node src/application-cli.mjs prepare JOB_ID [PORTAL_RESUME_ID] [ANSWERS_JSON] | submit INTENT_ID "EXACT APPROVAL"');
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(JSON.stringify({ error:error.code ?? 'ERROR', message:error.message })); process.exitCode = 1; }
finally { db.close(); }
