# Technical stack

| Component | Current choice | Evidence |
| --- | --- | --- |
| Runtime | Node.js ECMAScript modules | `package.json` scripts and `src/*.mjs` |
| MCP | `@modelcontextprotocol/sdk` with stdio transport | `src/mcp.mjs`; 17 tools discovered by direct client after Sprint 2B |
| Validation | Zod at MCP tool boundary; service-level ID and freshness checks | `src/mcp.mjs`, `src/job-packet.mjs` |
| HTTP | Native `fetch` against fixed RecruitSage API host | `src/http.mjs` |
| Auth | Supabase JWT plus rotating refresh token in owner-only local file | `src/auth.mjs`; live renewal previously verified |
| Gmail | Native fetch, OAuth Desktop PKCE, `gmail.readonly`, per-account token files | `src/gmail-auth.mjs`, `src/gmail-http.mjs`; live consent, sync and refresh verified 2026-10-29 |
| Database | Node `node:sqlite` `DatabaseSync`, SQLite WAL | `src/store.mjs`; existing local database migrated in place |
| Documents | `pdfjs-dist` PDF, `mammoth` DOCX, bounded `node:zlib` ZIP, native SHA-256 | `src/parse.mjs`, `src/jobs.mjs` |
| XLSX | `read-excel-file` 9.3.13, guarded OOXML/ZIP validation | `src/shortlist-xlsx.mjs`; live Deloitte workbook parsed locally |
| Tunnel | Existing official OpenAI `tunnel-client` and user LaunchAgent | `docs/CHATGPT_TUNNEL.md`; unchanged profile and tunnel ID |
| Tests | Native `node:test` with sanitized fixtures | `test/*.test.mjs`; Sprint 2C full suite 47/47 passed |

The Sprint 2C work queue is one SQLite table in the existing local database. No browser automation, vector database, external queue, framework-based agent or cloud database is used.
