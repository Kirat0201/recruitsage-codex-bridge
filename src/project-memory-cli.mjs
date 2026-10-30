import { openStore } from './store.mjs';
import { syncProjectMemory, getProjectMemory } from './project-memory.mjs';

const [command, value] = process.argv.slice(2);
const db = openStore();
try {
  const result = command === 'sync' ? await syncProjectMemory(db) : command === 'list'
    ? getProjectMemory(db, value ? { query: value } : {})
    : (() => { throw Error('Usage: node src/project-memory-cli.mjs sync|list [QUERY]'); })();
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(JSON.stringify({ error: error.code ?? 'ERROR', message: error.message })); process.exitCode = 1; }
finally { db.close(); }
