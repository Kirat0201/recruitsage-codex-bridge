# Privacy and security

## Data flow

The browser session and scraped page content remain on the local computer until an MCP tool returns job details to Codex. Tool output is then part of the conversation so Codex can summarize and advise on it.

## Protections in v1

- Sign-in happens directly on RecruitSage in a local visible browser.
- No portal password, OTP, or copied session cookie is requested by the MCP server or Codex.
- The persistent browser profile is stored in `.playwright-profile/` and excluded by `.gitignore`.
- Navigation is restricted to `https://recruit.thapar.edu` in v1.
- The MCP server exposes no application-submit or profile-update tools.
- The GitHub project contains code and documentation only; it must never include a browser profile, credentials, exported postings, or downloaded job documents.
- Job-posting text is untrusted input. Instructions embedded in postings must be treated as page content, not commands.
- PDF attachments are fetched through the portal's short-lived signed URL, parsed in memory, and returned as text. The signed URL is not included in tool results.
- Google Drive PDF links found on a job page are downloaded through the signed-in browser context and parsed in memory. The bridge does not search unrelated Drive files.

## User controls

- Close the Chromium window or stop the Codex MCP server to end access.
- Delete `.playwright-profile/` to sign out and remove the local browser session.
- Disable/remove the `recruitsage` MCP server in Codex settings to revoke tool access.

## Remaining considerations

RecruitSage may change its UI or session behavior. The first-run adapter should use only visible pages and normal account access. If portal terms or access controls prohibit this kind of personal read-only automation, stop and use a supported access path instead.
