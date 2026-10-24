# Implementation plan

## Phase 1 — Local MCP foundation

- [x] Create a dedicated project structure and product brief.
- [x] Define the local, read-only MCP and browser-session architecture.
- [x] Add a stdio MCP server with persistent visible Chromium.
- [x] Add tools for opening RecruitSage, inspecting pages, clicking visible controls, and reading a job page.
- [x] Exclude the browser profile and runtime data from version control.

## Phase 2 — Calibrate RecruitSage UI

- [ ] Start the MCP server from Codex and open the student portal.
- [ ] User signs in directly in the Chromium window.
- [ ] Inspect the actual tabs and confirm which label represents eligible jobs.
- [ ] Inspect one job card and one detail page to learn stable identifiers and fields.
- [ ] Add selectors/normalization only for elements observed in the real UI.

## Phase 3 — Job and document retrieval

- [ ] Implement `list_eligible_jobs` based on the portal's own eligibility tab/flags.
- [ ] Implement `get_job_description` with eligibility/status metadata and source links.
- [ ] Extract linked PDF text and support other document types found on actual postings.
- [ ] Bound page sizes and text lengths to keep tool output useful in chat.
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

- Exact portal tabs and card structure.
- Whether job details are inline, separate routes, or downloaded files.
- Which file formats need text extraction.
- Whether pages use pagination or lazy loading.
