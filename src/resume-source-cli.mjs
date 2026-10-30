import { openStore } from './store.mjs';
import { registerResumeSource, getResumeSource } from './resume-source.mjs';

const [command, resumeId, file] = process.argv.slice(2);
const db = openStore();
try {
  const result = command === 'register' ? await registerResumeSource(db, { resumeId, file }) : command === 'show'
    ? await getResumeSource(db, { resumeId })
    : (() => { throw Error('Usage: node src/resume-source-cli.mjs register RESUME_ID FILE | show RESUME_ID'); })();
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(JSON.stringify({ error: error.code ?? 'ERROR', message: error.message })); process.exitCode = 1; }
finally { db.close(); }
