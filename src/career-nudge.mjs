import { execFileSync } from 'node:child_process';
import { openStore } from './store.mjs';
import { careerBriefing, runCareerWorkflow } from './career-context.mjs';

const accountId = process.argv[2];
if (!accountId) throw Error('Usage: node src/career-nudge.mjs ACCOUNT_EMAIL [--preview]');
const preview = process.argv.includes('--preview');
const db = openStore();
try {
  if (!preview) await runCareerWorkflow(db, { accountId });
  const briefing = careerBriefing(db, { accountId });
  const action = briefing.actions[0];
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  db.exec('CREATE TABLE IF NOT EXISTS career_nudges (account_id TEXT NOT NULL, local_day TEXT NOT NULL, action_id TEXT NOT NULL, sent_at TEXT NOT NULL, PRIMARY KEY(account_id,local_day,action_id))');
  if (!action) { console.log(JSON.stringify({ state: 'nothing_pending', day: today })); process.exit(0); }
  const message = action.state === 'needs_review'
    ? `Check the uncertain ${action.kind.replaceAll('_', ' ')} notice. Open Sensei for the source.`
    : `${action.title}. Open Sensei for a sourced preparation question.`;
  const title = 'RecruitSage Sensei';
  const already = db.prepare('SELECT 1 FROM career_nudges WHERE account_id=? AND local_day=? AND action_id=?').get(accountId, today, action.actionId);
  if (already && !preview) { console.log(JSON.stringify({ state: 'already_sent', day: today, actionId: action.actionId })); process.exit(0); }
  if (preview) console.log(JSON.stringify({ state: 'preview', day: today, title, message, source: action.source?.ref ?? null }));
  else {
    // Pass text as argv so mail or job content cannot become AppleScript code.
    execFileSync('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title (item 2 of argv)', '-e', 'end run', message.slice(0, 220), title], { timeout: 10_000, stdio: 'pipe' });
    db.prepare('INSERT INTO career_nudges VALUES(?,?,?,?)').run(accountId, today, action.actionId, new Date().toISOString());
    console.log(JSON.stringify({ state: 'notification_requested', day: today, actionId: action.actionId, source: action.source?.ref ?? null }));
  }
} finally { db.close(); }
