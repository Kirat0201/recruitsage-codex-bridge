import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";

const CALLBACK = "http://127.0.0.1:48731/callback";
const b64url = (value) => value.toString("base64url");

function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => process.stderr.write(`Open this AWS sign-in URL manually: ${url}\n`));
  child.unref();
}

export async function loginWithCognito({ issuer, clientId }) {
  if (!issuer || !clientId) throw new Error("Set COGNITO_DOMAIN and COGNITO_COMPANION_CLIENT_ID.");
  const base = new URL(issuer);
  if (base.protocol !== "https:") throw new Error("Cognito issuer must use HTTPS.");
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(24));
  const authorize = new URL("/oauth2/authorize", base);
  authorize.search = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: CALLBACK, scope: "openid", code_challenge_method: "S256", code_challenge: challenge, state }).toString();

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const callback = new URL(req.url, CALLBACK);
      if (callback.pathname !== "/callback" || callback.searchParams.get("state") !== state) {
        res.writeHead(400).end("Invalid sign-in response.");
        return;
      }
      const value = callback.searchParams.get("code");
      res.writeHead(value ? 200 : 400, { "content-type": "text/plain" });
      res.end(value ? "RecruitSage cloud sign-in complete. You can close this tab." : "Sign-in failed.");
      server.close();
      if (value) resolve(value); else reject(new Error("Cognito did not return an authorization code."));
    });
    server.on("error", reject);
    server.listen(48731, "127.0.0.1", () => {
      process.stderr.write("Sign in to the AWS companion in the browser window.\n");
      openBrowser(authorize.toString());
    });
    const timeout = setTimeout(() => { server.close(); reject(new Error("Sign-in timed out.")); }, 180_000);
    server.on("close", () => clearTimeout(timeout));
  });
  const tokenResponse = await fetch(new URL("/oauth2/token", base), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, redirect_uri: CALLBACK, code_verifier: verifier }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!tokenResponse.ok()) throw new Error("Cognito token exchange failed.");
  const tokens = await tokenResponse.json();
  if (!tokens.access_token || !Number.isFinite(tokens.expires_in)) throw new Error("Cognito returned an invalid token response.");
  return { accessToken: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 };
}
