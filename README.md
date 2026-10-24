# RecruitSage Codex Bridge

A local, read-only MCP server that lets Codex inspect your signed-in RecruitSage pages and return eligible jobs and job descriptions in chat.

## How it works

1. Codex starts the local MCP server over stdio.
2. The server opens a dedicated visible Chromium profile using Playwright.
3. You sign in to RecruitSage normally the first time. The profile stays on your computer.
4. Ask Codex to inspect eligible opportunities. It reads the portal's own eligibility tabs and flags, then opens relevant job pages and reads their descriptions and linked documents.

The server does not submit applications, change portal data, or send portal passwords to an external service. Job text returned by a tool becomes part of the Codex conversation, as expected for analysis.

## Current status

This repository contains the project plan and an initial MCP server scaffold. RecruitSage is login-gated and its signed-in page structure is not visible to this development workspace, so the portal-specific tab and job-card selectors must be calibrated during the first local run. The initial tools expose the signed-in page's controls, links, and readable text so Codex can discover the UI without hard-coded eligibility rules.

## Setup

Requirements: Node.js 20+ and Codex desktop, CLI, or IDE with MCP enabled.

```sh
npm install
npx playwright install chromium
```

Register the project-local server with Codex from this directory:

```sh
codex mcp add recruitsage -- node "$PWD/src/server.mjs"
```

Restart Codex if it does not show the new server. Then ask Codex to use the `recruitsage` tools and open RecruitSage. The first call opens a visible browser window. Sign in there; do not put your credentials in chat or configuration.

## Tools

- `open_recruitsage`: opens the student portal or reports the current signed-in page.
- `inspect_page`: returns page title, current URL, visible controls, links, tabs, and readable text.
- `click_portal_control`: clicks a visible portal link, button, or tab by its displayed label.
- `read_job_page`: reads a RecruitSage job page and returns its text plus linked documents.

All browsing is limited to RecruitSage and document URLs discovered from RecruitSage pages. The server is read-only.

## Project documents

- [Project brief](docs/PROJECT_BRIEF.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md)
- [Privacy and security](docs/PRIVACY_SECURITY.md)
- [First-run checklist](docs/FIRST_RUN.md)

## Limitations

- The browser profile must remain available on the same computer where Codex runs.
- If RecruitSage changes its interface, the labels or page structure may need updating.
- PDFs and other document formats will be added after confirming which formats the portal links to.
- This first version reads the portal. It will not apply to jobs or alter your account.

## License

Private project for personal use unless a license is added later.
