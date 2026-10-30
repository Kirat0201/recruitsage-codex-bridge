# ChatGPT Secure MCP Tunnel

The local RecruitSage server remains stdio-only. The official `tunnel-client` v0.0.18 binary is installed at `/Users/harkiratkalra/.local/bin/tunnel-client` and profile `recruitsage-local` lives at `/Users/harkiratkalra/.config/tunnel-client/recruitsage-local.yaml`. Its MCP command uses the absolute Node and server paths. RecruitSage credentials stay in this project's owner-only `.env`; the current Plus-account OpenAI runtime key is in an owner-only file at `/Users/harkiratkalra/.config/tunnel-client/recruitsage-plus-openai.key`, referenced by the profile. No database listener or public port is opened. The previous remote tunnel was not deleted.

## Current local setup

- Tunnel ID: `tunnel_6ae22065b13481919bbb0a8c06542611` (Plus account).
- `tunnel-client doctor --profile recruitsage-local --explain` passed.
- User LaunchAgent `/Users/harkiratkalra/Library/LaunchAgents/com.harkirat.recruitsage-tunnel.plist` runs the client at login and restarts it on exit. It was restarted once and returned `live` and `ready` on a new loopback port. The Mac must be logged into this user account for a LaunchAgent to run.
- Health URL is written to `/private/tmp/recruitsage-tunnel-health.url`. Check with `/Users/harkiratkalra/.local/bin/tunnel-client health --url-file /private/tmp/recruitsage-tunnel-health.url --require-control-plane-poll --json`.
- Do not run a second foreground `tunnel-client run` while the LaunchAgent is active. The local profile and key file are mode 600, and the profile directory is mode 700.
- The tunnel metadata reports organization `org-1oYCvDj7KboF2P4u0Tev8F8r` and workspace `54fe3802-f3dc-4f56-8d7c-22d5f86a1a81`. ChatGPT successfully called the original tools through the tunnel. After Sprint 1.1, a direct stdio client discovered all 14 tools and called `get_document_excerpt` locally; ChatGPT discovery of the two newest tools remains unverified.
- A live `sync_jobs` MCP call succeeded on 2026-10-28 at 17:49:19 UTC: 522 jobs, 522 eligibility results, 16 requests. A live `get_job_details` MCP call also succeeded, and local discovery returned all 12 tools. At 18:31 UTC, an owner-supplied refresh token bootstrapped the local session; a second real Supabase refresh rotated the saved token. A forced live sync after renewal stored 522 jobs and checked 522 eligibility results at 18:31:49 UTC. The saved session has mode 600 inside a mode 700 directory. The existing LaunchAgent and Plus-account tunnel remained running and healthy. The account owner then confirmed a successful ChatGPT `get_job_details` call through the already-running tunnel child after rotation. Keep RecruitSage credentials in the project's owner-only local files, separate from the OpenAI tunnel key.

## Connect in ChatGPT

Open ChatGPT Plugins, select **+ → Add custom MCP server**, name it **RecruitSage**, choose **Tunnel** under **Connection**, and select `tunnel_6ae22065b13481919bbb0a8c06542611` (or paste it). Choose **No authentication** for the MCP server: this stdio server has no OAuth endpoint, while the tunnel and ChatGPT workspace association control access. Review the warning, select **I understand and want to continue**, then **Create as a plugin**. Install the resulting personal/workspace plugin before using it in a conversation. Keep the LaunchAgent running during discovery and tool calls.

Test in ChatGPT with: “Use RecruitSage `sync_jobs`, then `list_applied_jobs` with limit 1, and tell me the total and sync timestamp.” A successful ChatGPT tool call is the final integration check; local MCP tests alone cannot establish it.

Sources: [official OpenAI Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), [Add custom MCP server guide](https://developers.openai.com/api/docs/guides/custom-mcp-server).
