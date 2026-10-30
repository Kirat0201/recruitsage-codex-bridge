import { loadLocalAuth } from './auth.mjs';
import { openStore, listJobs, cachedJob } from './store.mjs';
import { rpc } from './http.mjs';
import { syncJobs, listAppliedJobs, listNewJobs, listAvailableJobs, listClosedJobs, getJobDetails, getJobAttachments, downloadJobDescription, getApplicationStatus, getRecruitmentRounds } from './jobs.mjs';
import { getJobPacket } from './job-packet.mjs';
import { getDocumentExcerpt } from './document-excerpt.mjs';

loadLocalAuth();
const [command, kind, value] = process.argv.slice(2);
try {
  const db = openStore();
  let result;
  switch (command) {
    case 'probe': {
      const response = await rpc('get_student_job_bundle_page', { p_limit: 1 });
      if (!Array.isArray(response?.mappings)) throw new Error('Unexpected bundle response');
      result = { live: true, totalJobs: response.totalJobs, rows: response.mappings.length, revision: response.revision ?? null };
      break;
    }
    case 'sync': result = await syncJobs(db, { force: kind === '--force' }); break;
    case 'jobs': {
      const options = { limit: Number(value) || 20 };
      result = kind === 'available' ? listAvailableJobs(db, options) : kind === 'closed' ? listClosedJobs(db, options) : kind === 'applied' ? listAppliedJobs(db, options) : kind === 'new' ? listNewJobs(db, options) : listJobs(db, options);
      break;
    }
    case 'detail': result = await getJobDetails(kind); break;
    case 'files': result = await getJobAttachments(kind); break;
    case 'download': result = await downloadJobDescription(db, kind); break;
    case 'application': result = getApplicationStatus(db, kind); break;
    case 'rounds': result = getRecruitmentRounds(db, kind); break;
    case 'cached': result = cachedJob(db, kind); break;
    case 'packet': result = await getJobPacket(db, { jobId: kind, freshness: value ?? 'auto', includeDocuments: process.argv.includes('--documents') }); break;
    case 'excerpt': {
      const characterOffset = /^\d+$/.test(value ?? '');
      result = await getDocumentExcerpt(db, { ...(kind?.length === 64 ? { sha256: kind } : { documentId: kind }),
        keyword: characterOffset ? undefined : value, offset: Number(characterOffset ? value : process.argv[5] ?? 0) });
      break;
    }
    default: throw new Error('Usage: node src/cli.mjs probe|sync|jobs [all|available|applied|new|closed] [limit]|detail ID|files ID|download ID|application ID|cached ID|packet ID [live|cache|auto] [--documents]|excerpt DOCUMENT_ID_OR_SHA256 [keyword] [offset]');
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(JSON.stringify({ error: error.code ?? 'ERROR', message: error.message })); process.exitCode = 1; }
