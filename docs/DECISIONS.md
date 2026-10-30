# Engineering decisions

## Preserve the active API-first working tree

Git `main` contains the older browser-based implementation, while the working tree contains the verified direct-HTTP bridge. Sprint 1 extends the working tree. No checkout, reset, credential replacement or remote push was performed.

## Keep packet logic outside MCP

`src/job-packet.mjs` is called by both CLI and MCP. The MCP tool validates inputs with Zod and returns compact JSON. Detail, application and attachment reads reuse existing HTTP and job services.

## Label each source independently

A live packet performs authenticated detail, attachment and application requests. Eligibility and rounds remain cached with their own timestamps because a trustworthy per-job live rounds query was not verified. Cached document text is labeled even when attachment metadata was just fetched live. Fifteen minutes is the current `auto` packet-snapshot policy, not a portal guarantee.

## Track removals without deleting history

The additive SQLite migration marks absent jobs as not present and records `removed_at`; it leaves prior payloads available for historical inspection. The first complete sync is a baseline, so it creates zero new-job alerts. Subsequent full snapshots distinguish additions, edits, removals and restorations.

## Bound document handling

Known PDF/ZIP/DOCX signatures and MIME conflicts are checked. ZIP central-directory sizes, member count, paths, decompressed size and compression ratio are bounded before extraction. Documents stay local and the MCP packet returns at most 2,000 characters per excerpt plus a SHA-256 evidence reference. Scanned PDFs are labeled; OCR is deferred until a real case justifies it.

## Preserve read-only authorization

Application submission is the sole portal mutation exposed. It uses RecruitSage's own observed Edge Function, an expiring local intent, exact per-job approval, no automatic mutation retry, and a live application-row confirmation. Email, calendar, offer and unrelated profile mutations remain unavailable. Supabase credentials stay in ignored owner-only files. The existing Plus-account tunnel and LaunchAgent are retained.

## Resolve excerpts by evidence ID, never by path

`get_document_excerpt` accepts a document UUID or SHA-256, resolves it in SQLite, and constructs the only allowed path under the local document cache. It never accepts a caller-supplied path. Character pagination and literal keyword matching keep results bounded without embeddings. PDF page spans are persisted during extraction; legacy binaries are reparsed locally once and compared with cached text before page numbers are claimed. A SHA-256 matching multiple document rows requires a job ID or document ID to disambiguate.

## Gmail Sprint 2A: separate account-scoped OAuth and bounded sync

The local application cannot use ChatGPT's Gmail connector. Desktop OAuth with PKCE and `gmail.readonly` provides a separate authorized Gmail session. The user performs consent manually. Account identity comes from Gmail's profile endpoint, not an arbitrary CLI label. Refresh credentials are owner-only and never enter MCP output. The existing RecruitSage and tunnel credentials are independent.

Initial synchronization uses a narrow Gmail query, local subject/sender filters, a 100-message cap and a pre-scan history anchor. Later runs consume `users.history.list`; expired cursors trigger a bounded baseline instead of silently losing changes. Bodies are fetched only for new matching messages during incremental sync. The SQLite primary keys include account ID, preventing cross-account identity collisions. A changed filter invalidates old docket links before its new baseline.

The first docket matcher uses exact RecruitSage job ID or normalized company and role text. A partial company-name match is flagged for review. Application status comes only from the RecruitSage application row.

## Sprint 2B: stage-specific shortlist evidence

Selection status is derived from attachment contents and a verified local identity. Exact university email or explicitly labeled roll/registration ID is preferred; name-only hits require review. An opaque `Candidate Id` column is not assumed to be a university registration number. Formula-bearing, external-link, macro or embedded-content XLSX packages are rejected. XLSX ZIP bounds and signatures are checked before the maintained parser runs; formulas are never evaluated. Attachments are stored by SHA-256 under an owner-only local directory.

One event is keyed to account, message, job, attachment hash and stage. History remains available; revised releases supersede an earlier result only when explicitly indicated and later in time. Otherwise opposing outcomes become `needs_review`. A person absent from a list is `unknown` unless list completeness is established. Stage outcomes do not carry over to later stages. The event projection appears on each message-linked docket row for convenience, while the event table contains one canonical record.

Live Deloitte evidence on 2026-10-29: university-domain message `1a16757db19c9741`, XLSX hash `270f0db0b5532d9500f0e96ecc2b854ba247bb55541e91f50dd7c11bf38d4da0`, unique RecruitSage association by Deloitte plus Cloud Computing role fragment. The verified university email matched Sheet1 row 64, column 4. Filename and message classify this event as GD shortlist for Oct 26–27. No subsequent interview stage is evidenced by this workbook, so none is recorded.

## Sprint 2C: durable bounded triage

The Gmail history cursor must never outrun unrecorded attachment work. `saveGmailSync` therefore enqueues candidate message IDs and advances the cursor in one transaction. A synchronous, bounded drain processes three items at most per sync. Pending/error items survive process interruption and are retried; ambiguous job, stage or identity evidence remains in a local review state. Existing selection event keys and attachment hashes prevent duplicate outcomes and downloads. No new MCP tool is needed; queue counts and safe source references extend the existing Gmail sync and docket responses.

The configured initial scan remains narrow. Incremental history may fetch a full message with a shortlist subject outside that query, but stores it only when it has a supported attachment and shortlist evidence. A company-only match among several RecruitSage jobs cannot assign a canonical job; this is a review case. The real EY shortlist message `1a15dd4b1e24ecdf` demonstrates that limit: XLSX present, unique role and stage absent. No EY selection event was created.
