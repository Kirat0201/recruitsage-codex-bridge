import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loginWithCognito } from "./cloud/login.mjs";

const cloudUrl = process.env.RECRUITSAGE_CLOUD_URL;
if (!cloudUrl || new URL(cloudUrl).protocol !== "https:") {
  throw new Error("Set HTTPS RECRUITSAGE_CLOUD_URL.");
}
const origin = new URL(cloudUrl).origin;
let session = await loginWithCognito({ issuer: process.env.COGNITO_DOMAIN, clientId: process.env.COGNITO_COMPANION_CLIENT_ID });
const agentId = randomUUID();
const local = new Client({ name: "recruitsage-laptop-companion", version: "0.2.0" });
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("./server.mjs", import.meta.url))], stderr: "inherit" });
await local.connect(transport);

async function post(path, body) {
  if (Date.now() > session.expiresAt - 300_000) {
    session = await loginWithCognito({ issuer: process.env.COGNITO_DOMAIN, clientId: process.env.COGNITO_COMPANION_CLIENT_ID });
  }
  const response = await fetch(new URL(path, origin), {
    method: "POST",
    headers: { authorization: `Bearer ${session.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok()) throw new Error(`Cloud companion endpoint returned HTTP ${response.status}.`);
  return response.json();
}

process.stderr.write("RecruitSage companion running. Sign in to RecruitSage in the local browser when it opens.\n");
let lastHeartbeat = 0;
while (true) {
  try {
    if (Date.now() - lastHeartbeat > 15_000) {
      await post("/agent/heartbeat", { agentId });
      lastHeartbeat = Date.now();
    }
    const { request } = await post("/agent/next", { agentId });
    if (request) {
      let result;
      if (!["list_eligible_jobs", "get_job_description"].includes(request.tool)) {
        result = { isError: true, content: [{ type: "text", text: "Unsupported tool." }] };
      } else {
        try {
          result = await local.callTool({ name: request.tool, arguments: request.args ?? {} });
        } catch {
          result = { isError: true, content: [{ type: "text", text: "Local portal read failed. Check the visible browser and companion terminal." }] };
        }
      }
      await post("/agent/result", { agentId, requestId: request.requestId, result });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } catch (error) {
    process.stderr.write(`Companion connection: ${error.message}\n`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
