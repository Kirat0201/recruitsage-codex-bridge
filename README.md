# RecruitSage MCP Bridge

A read-only RecruitSage MCP bridge. The original local server still works. An AWS-hosted MCP endpoint and laptop companion are being built so each student can use their own signed-in RecruitSage session without sending portal credentials or cookies to AWS.

**AWS status:** Cloud and companion code plus deployment templates are present and local security tests pass. The service has not been deployed or tested against a real Cognito/App Runner account. The user pool template is invite-only. See [AWS deployment](docs/AWS_DEPLOYMENT.md) for the data flow, setup, and remaining live checks.

## How it works

1. Codex starts the local MCP server over stdio.
2. The server opens a dedicated visible Chromium profile using Playwright.
3. You sign in to RecruitSage normally the first time. The profile stays on your computer.
4. Ask Codex to inspect eligible opportunities. It reads the portal's own eligibility tabs and flags, then opens relevant job pages and collects their descriptions and document links.

The server does not submit applications, change portal data, or send portal passwords to an external service. Job text returned by a tool becomes part of the Codex conversation, as expected for analysis.

For the hosted path, the laptop companion keeps the RecruitSage browser local and sends only eligible job results to AWS. The AWS broker uses per-user Cognito access tokens and temporarily stores each request/result in encrypted DynamoDB before deleting it. RecruitSage passwords, cookies, and portal session tokens stay on the laptop.

## Current status

The local session has been calibrated against the signed-in student portal. Its Jobs page has an **Open to you** tab and opens job-table rows on separate detail routes. The dedicated tools were smoke-tested against the signed-in portal, including PDF extraction from portal-hosted attachments and linked Google Drive files.

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
- `click_portal_control`: opens same-site links, navigation controls, and job-table rows. Form controls and other action buttons are blocked.
- `read_job_page`: reads a RecruitSage job page and returns its text plus document links. Use `get_job_description` to extract PDF text for an eligible job.
- `list_eligible_jobs`: returns rows from the portal's **Open to you** tab with stable detail-page URLs.
- `get_job_description`: reads a job found by `list_eligible_jobs` and extracts text from portal-hosted PDF attachments and linked Google Drive PDFs.

All browsing is limited to RecruitSage and document URLs discovered from RecruitSage pages. The server is read-only.

The persistent profile can be used by only one Chrome for Testing process at a time. If `open_recruitsage` reports that another session is using it, close that browser window and retry. Keep `.playwright-profile/` intact so the local sign-in is preserved.

To verify the live flow locally, run `npm run smoke` while the registered MCP server's Chrome for Testing window is closed. The smoke check prints counts and text lengths, not posting contents or signed document links.

## Project documents

- [Project brief](docs/PROJECT_BRIEF.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md)
- [Privacy and security](docs/PRIVACY_SECURITY.md)
- [First-run checklist](docs/FIRST_RUN.md)

## Limitations

- The browser profile must remain available on the same computer where Codex runs.
- If RecruitSage changes its interface, the labels or page structure may need updating.
- PDF extraction is bounded to 20 MB, 50 pages, and 24,000 text characters per document. Future postings may use other formats that need additional support.
- This first version reads the portal. It will not apply to jobs or alter your account.
- The AWS path requires a real deployment and OAuth integration test before it can be offered to other students.

## License

Private project for personal use unless a license is added later.
