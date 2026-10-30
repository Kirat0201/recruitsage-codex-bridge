# RecruitSage API bridge

Read-only Node.js backend for an authorized RecruitSage account. CLI and MCP use the same HTTP and SQLite modules. No browser automation is present. The discovered API routes are undocumented and may change.

## Setup

Requires Node.js 22.13+ (tested on Node 26). Run `npm install`. Create a local `.env` in this project with `RS_ANON_KEY=` and `RS_ACCESS_TOKEN=` from an authorized RecruitSage session, then `chmod 600 .env`. Never paste credentials into chat or commit them. The saved HAR contains no authentication exchange or refresh-token value. The bridge does not collect your password, perform login, or bypass account protections.

The portal uses Supabase Auth JWTs. A valid refresh token enables automatic renewal 60 seconds before expiry and one refresh-and-retry on HTTP 401. Refreshed access and refresh tokens are rotated into ignored `data/auth/session.json` with mode 600; the directory is mode 700. The MCP process rereads the session and `.env` for every request, so the tunnel child can use rotated credentials without restarting. HTTP 403 remains an access-denied error.

If `AUTH_REFRESH_REQUIRED` appears, obtain a valid refresh token **from your own authorized session** and bootstrap it once locally. At the project directory, use a hidden terminal prompt (zsh):

```sh
read -s 'RS_REFRESH?RecruitSage refresh token: '
printf '%s' "$RS_REFRESH" | npm run auth:bootstrap
unset RS_REFRESH
```

This pipes the token through stdin; it does not put it in shell history, process arguments, or MCP output. Do not paste the token into chat. Bootstrap returns only a success flag and expiry, then future refreshes use the encrypted-in-transit Supabase Auth endpoint. If you cannot obtain a valid refresh token through an authorized session, supply a newer access token in the owner-only `.env` as a temporary fallback; automatic renewal will remain unavailable. The CLI does not implement an unverified password, OAuth, MFA, or CAPTCHA flow.

`AUTH_REFRESH_ALREADY_USED` means the RecruitSage server has already consumed the saved refresh token. The local file is preserved; repeating a refresh with it cannot repair the session. Sign in manually to your own RecruitSage account, capture a **new** refresh token from your authorized Supabase auth response, and repeat the hidden-stdin bootstrap above. Do not paste the token into chat or a command argument. The bridge uses an owner-only cross-process lock and atomic file replacement; a server-side rotation that succeeds immediately before a local process crash may still require a new authorized bootstrap.

The RecruitSage auth service rejected a direct CLI email OTP request with `captcha_failed` on 2026-10-29. Do not try to bypass its CAPTCHA. Complete portal sign-in manually before bootstrapping; the CLI cannot independently create a new authorized session under this protection.

The API host is fixed to `https://api.recruit.thapar.edu`. Credentials are sent only to approved API routes there. This project uses observed backend routes, not a supported public API contract. Confirm your access complies with portal policies.

## CLI

```sh
npm run probe                  # one live bundle request
npm run sync                   # live sync; skips if the last sync was <5 minutes ago
npm run sync -- --force        # force a refresh
npm run jobs:applied           # cached confirmed application rows
npm run jobs:new               # first seen in latest sync
npm run jobs:available         # live eligibility result cached by sync
npm run jobs:closed            # jobs marked closed by eligibility RPC
node src/cli.mjs jobs all 30
node src/cli.mjs detail JOB_UUID
node src/cli.mjs files JOB_UUID
node src/cli.mjs download JOB_UUID
node src/cli.mjs packet JOB_UUID live --documents
node src/cli.mjs packet JOB_UUID cache --documents
node src/cli.mjs excerpt DOCUMENT_ID_OR_SHA256 experience 0
node src/cli.mjs excerpt DOCUMENT_ID_OR_SHA256 700  # character offset
npm test
```

Job summaries and document paths stay small. Downloaded documents and extracted text are stored under ignored `data/`, with owner-only permissions. Source job IDs and attachment metadata are stored in SQLite. The raw ZIP reference snapshot remains separate and is never treated as live data.

## MCP

For autonomous completion of a selected job, call `run_application_autopilot({jobId})`. It uses the portal resume and saved candidate facts, asks for `missingQuestions`, then resumes when called with user-provided `answers`. Store reusable facts with `save_candidate_facts`; inspect pending work with `get_application_queue`. File/video questions require manual portal upload. Background job selection and unattended prompting are not part of this workflow.

Register this project's `src/mcp.mjs` as a stdio MCP server, for example `codex mcp add recruitsage -- node /ABSOLUTE/PATH/src/mcp.mjs`. The server resolves `.env` and `data/` relative to its own source tree. The current server exposes 34 tools across jobs, Gmail evidence, career briefing, Sensei practice, project/resume memory, and application execution. List tools have `limit` and `offset`; full document text remains in a local file and is not returned as a tool result.

`prepare_job_application` is read-only: it performs fresh duplicate/eligibility checks, selects a portal resume, validates screening answers, and returns an exact approval phrase in a 30-minute intent. `submit_job_application` is the sole RecruitSage mutation and must only be called after the owner sends that exact phrase. It invokes the portal's observed `submit-job-application` Edge Function once and verifies the resulting application row. An unknown network outcome is never retried automatically or called successful. CLI equivalents are `npm run application:prepare -- JOB_ID` and `npm run application:submit -- INTENT_ID "EXACT APPROVAL"`.

`get_job_packet({jobId, freshness, includeDocuments, maxExcerptChars})` combines identity, bounded role text, salary, deadline, eligibility, application status, rounds, and document metadata/excerpts. `live` performs authenticated detail, attachment, and application reads; eligibility and rounds are still labeled as cached. `cache` makes no network calls. `auto` uses a packet snapshot at most 15 minutes old when requested documents are cached, otherwise it fetches live. Fresh attachment metadata does not imply a fresh binary download: extracted text reports its local cache source, SHA-256, and download time when known. See [architecture](docs/ARCHITECTURE.md) and [progress](docs/PROGRESS.md).

`get_document_excerpt({documentId?, sha256?, jobId?, keyword?, offset?, limit?, maxResults?})` reads only previously extracted local text. Supply a document UUID or the 64-character SHA-256 from a packet's `evidenceRef`. Without `keyword`, `offset` is a character offset and the response returns one excerpt. With a literal, case-insensitive `keyword`, `offset` is the match index and up to `maxResults` matches are returned. `limit` is 100–1,200 characters; `maxResults` is 1–3. The response includes page numbers when the cached PDF page map exists, character boundaries, source, and extraction time. Legacy PDFs are reparsed from their cached binary once to backfill page evidence; this makes **zero network requests**. A missing or mismatched local file fails explicitly. No arbitrary file path is accepted.

## Gmail placement docket (Sprint 2A)

The Gmail client is separate from ChatGPT's Gmail connector. It requests only `gmail.readonly`; it cannot send, delete or label mail. OAuth and message bodies stay in ignored local `data/`, never in MCP responses. Configure Google Cloud manually: enable the Gmail API, configure the OAuth consent screen, add your Gmail address as a test user if the app is in Testing, create an **OAuth Desktop app** client, and download its JSON. Do not send that JSON or any token to ChatGPT. From this project directory:

```sh
mkdir -p data/gmail && chmod 700 data/gmail
install -m 600 /YOUR/LOCAL/PATH/client_secret.json data/gmail/oauth-client.json
npm run gmail:auth
```

The last command prints a Google consent URL and waits on `127.0.0.1` for five minutes. **Open the URL yourself**, sign in to the account you authorize, and approve read-only access. The CLI does not launch a browser. It stores that account's token in an owner-only file under `data/gmail/tokens/`, keyed by the account identity returned by Gmail. If Google's Testing mode expires the refresh grant, repeat `npm run gmail:auth` yourself. The client renews access tokens automatically while the grant remains valid.

Configure a narrow placement query and local matching rule, then sync:

```sh
npm run gmail:configure -- student@example.edu 'subject:Deloitte' Deloitte
npm run gmail:sync -- student@example.edu --live
npm run gmail:docket -- student@example.edu
```

Replace the example address with the authorized Gmail profile address. The initial scan is capped at 100 messages and five pages; narrow the query if the cap is reached. Later syncs use Gmail history IDs and re-scan a bounded baseline if the cursor expires. `auto` reuses a sync less than five minutes old; `live` makes a Gmail API request or fails. Changing a filter invalidates its old docket matches and starts a new baseline. Docket links use RecruitSage IDs or company and role text and carry source IDs and timestamps. Selection status remains unknown without direct evidence; a shortlist attachment alone does not establish selection.

MCP adds `sync_gmail({accountId, freshness?, maxMessages?})`, `get_placement_docket({accountId, freshness?, from?, to?, status?, limit?, offset?})`, and `analyze_shortlist_email({accountId, jobId, messageId, mode?})`. The last tool analyzes one selected message attachment or returns that job's stage event history. It returns only matched student coordinates, outcome, hash, stage and source reference; it never returns other students' rows. Current local tool count is 17.

Configure the verified Gmail email identity and optionally import additional identity fields from a private local JSON file (`accountId`, `universityEmail`, optional `fullName`, `nameVariants`, and `registrationIds`):

```sh
npm run identity:configure -- student@example.edu
npm run identity:import -- student@example.edu < /private/path/student-identity.json
npm run shortlist:analyze -- student@example.edu JOB_UUID GMAIL_MESSAGE_ID
npm run shortlist:history -- student@example.edu JOB_UUID
```

Identity data is saved under `data/identity/` with owner-only permissions. Shortlist analysis makes live Gmail message/attachment reads as needed, reuses hash-verified local attachment bytes, and stores stage events in the existing SQLite database. Missing identity, unclear job/stage, ambiguous matches and extraction failures remain explicit. Absence from an unverified list does not mean rejection. The existing Plus-account tunnel serves the same stdio MCP; no separate Gmail server or ChatGPT Gmail connector is used.

## Status and boundaries

- Offline tests cover pagination, partial-response detection, snapshot additions/edits/removals, packet freshness, caching, SQLite, credential-safe errors, extraction, MCP startup, and auth refresh/retry/concurrency.
- Live probe and sync succeeded on 2026-10-28: 522 jobs across 5 bundle requests, 522 eligibility checks across 11 RPC batches, 130 application rows, 336 closed jobs and 0 currently eligible, open, unapplied jobs. The available classification uses the API's `eligible` flag and excludes closed and already applied jobs. This is an API-derived classification; it has not been compared against the current visual portal tab.
- Live authentication renewal succeeded twice on 2026-10-28: one bootstrap using an authorized refresh token supplied by the account owner and one subsequent rotation through the normal `AuthManager.valid()` path. The persisted session file is mode 600 in a mode 700 directory. A forced live sync after renewal stored 522 jobs and checked 522 eligibility results in 16 requests at 18:31:49 UTC. The account owner confirmed that ChatGPT successfully called `get_job_details` through the already-running tunnel child after rotation.
- A live job detail and attachment lookup succeeded. A 410,094-byte PDF was downloaded and 2,497 text characters extracted locally. Live ZIP and DOCX samples were not available in this verification.
- A repeated sync within five minutes uses zero requests. After that, a full paginated bundle and eligibility fetch is required; revision-aware incremental behavior awaits a verified live contract.
- PDF, DOCX, ZIP and text formats are parsed locally. ZIP central-directory sizes, unsafe paths, expanded bytes, compression ratio, member count, encryption and ZIP64 are limited or rejected. Scanned PDFs are labeled; OCR is not implemented. Real ZIP and DOCX samples have not yet been verified.
- No applications, profile changes, autonomous agent, or Fo integration are implemented.
