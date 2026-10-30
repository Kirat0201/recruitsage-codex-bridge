# Roadmap

1. **Sprint 0 — Stabilization:** complete for the current working tree. API-first modules, local data, auth, tests and tunnel were reconciled. The Git baseline remains uncommitted and should be reviewed before any commit.
2. **Sprint 1 / 1.1 — RecruitSage Job Intelligence:** job packet and bounded local document excerpt retrieval implemented. Direct stdio MCP discovery verified 14 tools. Remaining: ChatGPT discovery of the two newest tools, more live ZIP/DOCX evidence if such files appear, and a verified incremental sync contract.
3. **Sprint 2A — Gmail and first placement docket:** complete. Desktop OAuth, access-token renewal, bounded initial and history-based incremental sync, account-scoped SQLite, deterministic job links and two tools are implemented. Live sync found three Deloitte links.
4. **Sprint 2B — Evidence-based shortlist intelligence:** complete locally. Live Deloitte XLSX attachment retrieval, safe parsing, exact university-email match, GD event persistence and stage-specific docket projection are verified. Direct MCP discovers 17 tools; ChatGPT has confirmed the cached GD outcome through `get_placement_docket`, but the new 17th tool's discovery in ChatGPT remains unverified.
5. **Sprint 2C — Incremental shortlist triage:** implemented locally. New/changed supported shortlist messages enter an account-scoped SQLite queue in the same transaction as the Gmail history cursor. Each sync handles at most three items through the existing analyzer; ambiguous jobs/stages and permanent extraction errors require review. Fixture verification covers XLSX identity, idempotency, ambiguity and retry after failure. Live incremental Gmail sync succeeded, but no new eligible shortlist arrived, so a new live automatic selection event is unverified. An authorized EY shortlist email was recognized read-only; its role and stage were ambiguous, so no outcome was inferred.
6. **Sprint 2D — Deadline and schedule extraction:** next. Extract explicit dates and times from newly linked placement messages with source spans, distinguish application deadlines from assessment and interview schedules, and add opt-in scheduled docket sync with bounded lookback and failure reporting. Verify one genuine dated notice before enabling reminders or calendar writes.
7. **Sprint 3 — Resume Intelligence:** planned, not implemented. Multiple resumes, evidence-backed skills and projects, deterministic eligibility and factual tailoring suggestions.
8. **Sprint 4 — Sensei Mode:** planned, not implemented. Role fundamentals, project defense, adaptive practice, scoring and progress history.
9. **Sprint 5 — Production Hardening:** planned. Fault recovery, security review, resource optimization and scheduling. Cloud deployment remains optional and requires separate approval.

No autonomous external actions are in scope.

## Sprint 2B verification notes

- Real attachment parsed and identity matched; see `docs/PROGRESS.md` for message ID, hash, row and column provenance.
- The verified result is GD-specific. No final-interview evidence exists in that workbook.
- ChatGPT confirmed the cached docket outcome, but its reported tool list remains 16; direct MCP discovery is 17. Refresh the existing ChatGPT connector before relying on the new tool there.
