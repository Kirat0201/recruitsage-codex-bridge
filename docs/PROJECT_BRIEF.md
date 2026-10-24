# Project brief

## Goal

Give Codex on-demand, read-only access to the user's eligible RecruitSage opportunities and their job descriptions, so job analysis and advice can happen in the same conversation.

## User workflow

1. Ask Codex to open RecruitSage.
2. Sign in directly in the visible local browser the first time.
3. Ask Codex to check eligible jobs, compare postings, or read a specific job description.
4. Codex uses MCP tools to navigate the portal's eligible tab and fetch the job pages as conversational context.

## Product decisions

- Treat RecruitSage's own eligible status and tabs as authoritative.
- Use visible website pages and the existing browser session because the portal has no official API.
- Keep the browser profile and MCP server local to the user's computer.
- Make all tools read-only. No application submission, profile edits, or portal-side state changes.
- Return original portal links and label each result with the page it came from.
- Ask for explicit confirmation before any future feature that writes to RecruitSage.

## In scope

- Local MCP server compatible with Codex.
- Persistent, headed browser profile for one-time sign-in.
- Page inspection and navigation through visible portal controls.
- Reading job pages and collecting links to attached documents.
- Job summaries and application advice in the ongoing Codex conversation.

## Out of scope for v1

- Reimplementing eligibility logic.
- Applying to jobs, editing the student profile, or accepting offers.
- Background monitoring when Codex is not running.
- Uploading job data to a hosted service.
- Reliably parsing every document format before the portal's linked file types are known.

## Success criteria

- A user can sign in once in the local browser profile.
- Codex can identify the portal's eligible tab and return only records the site marks eligible.
- Codex can open a selected job page and include its description and source link in the chat.
- The MCP service does not expose tools that mutate portal data.
- No passwords, session cookies, or job data are committed to GitHub.
