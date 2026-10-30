# First-run checklist

> Historical v1 browser setup. Use the README for the current CLI-only API bridge.

1. Install Node.js 20 or later.
2. In this directory, run `npm install` and `npx playwright install chromium`.
3. Register the MCP server in Codex with:

   ```sh
   codex mcp add recruitsage -- node "$PWD/src/server.mjs"
   ```

4. Restart Codex if the server is not immediately listed.
5. Ask Codex to call `open_recruitsage`.
6. Sign in to RecruitSage in the visible Chromium window. Keep credentials in the website's own login form.
7. Ask Codex to inspect the page and identify the Eligible tab. The first session is also how we calibrate the portal-specific job adapter.

If `open_recruitsage` says the browser profile is already open, close the other Chrome for Testing window and retry. Do not delete `.playwright-profile/` to fix a profile lock; it stores the local sign-in.

To remove the local session, stop the MCP server and delete `.playwright-profile/`. Never commit that directory.
