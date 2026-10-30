# Implementation plan

> Historical v1 checklist. See README for the active API-first implementation and verification status.

## Phase 1 — Local MCP foundation

- [x] Create a dedicated project structure and product brief.
- [x] Define the local, read-only MCP and browser-session architecture.
- [x] Add a stdio MCP server with persistent visible Chromium.
- [x] Add tools for opening RecruitSage, inspecting pages, clicking visible controls, and reading a job page.
- [x] Exclude the browser profile and runtime data from version control.

## Phase 2 — Calibrate RecruitSage UI

- [x] Start the MCP server from Codex and open the student portal.
- [x] User signs in directly in the Chromium window.
- [x] Inspect the actual tabs and confirm that **Open to you** represents eligible jobs.
- [x] Inspect job-table rows and detail pages to learn stable routes and fields.
- [x] Add selectors/normalization only for elements observed in the real UI.

## Phase 3 — Job and document retrieval

- [x] Implement `list_eligible_jobs` based on the portal's own eligibility tab/flags.
- [x] Implement `get_job_description` with eligibility source and portal links.
- [x] Integration-test the new tools against the signed-in browser profile.
- [x] Extract PDF text from portal-hosted files and linked Google Drive files.
- [x] Bound PDF size, page count, and extracted text length.
- [ ] Return clear errors for expired login, closed postings, or missing attachments.

## Phase 4 — Chat workflow polish

- [ ] Add stable job IDs or URLs so follow-up questions resolve to the same posting.
- [ ] Include deadlines, compensation, location, eligibility text, and hiring steps when present.
- [ ] Add prompt guidance to compare eligible jobs against the user's goals and resume context.
- [ ] Make stale page/session state visible in the tool result.

## Phase 5 — Release

- [ ] Confirm all tools remain read-only.
- [ ] Review the final source tree for secrets and generated browser data.
- [ ] Document Codex registration and first sign-in.
- [ ] Publish the project to a dedicated GitHub repository.

## Open decisions after first portal inspection

- Whether the eligible-jobs table uses pagination or lazy loading as its count grows.
- Whether other document formats appear on future postings.
