import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createApp } from "../src/cloud/app.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const calls = [];
const broker = {
  heartbeat: async (user, agent) => calls.push(["heartbeat", user, agent]),
  activeAgent: async () => "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  claimNext: async (user, agent) => { calls.push(["next", user, agent]); return null; },
  completeRequest: async (user, agent, id) => calls.push(["result", user, agent, id]),
  createRequest: async (user, agent, tool, args) => { calls.push(["dispatch", user, tool, args]); return "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"; },
  getRequest: async () => ({ status: "complete", result: { content: [{ type: "text", text: "test job" }] } }),
  deleteRequest: async (user, id) => calls.push(["delete", user, id]),
};
const authenticate = async (header, route) => {
  if (route === "companion" && header === "Bearer student-a") return { userId: "student-a" };
  if (route === "companion" && header === "Bearer student-b") return { userId: "student-b" };
  if (route === "mcp" && header === "Bearer mcp-a") return { userId: "student-a" };
  return null;
};
const app = createApp({ broker, authenticate, issuer: "https://example.auth.us-east-1.amazoncognito.com", publicOrigin: "https://mcp.example.com" });
let base;
before(async () => {
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${app.address().port}`;
});
after(() => app.close());

async function send(path, token, body = {}) {
  return fetch(base + path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("rejects absent and wrong-audience tokens before broker access", async () => {
  const beforeCount = calls.length;
  assert.equal((await send("/agent/heartbeat", "mcp-a", { agentId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" })).status, 401);
  assert.equal((await send("/mcp", "student-a", { jsonrpc: "2.0", method: "tools/list", id: 1 })).status, 401);
  assert.equal(calls.length, beforeCount);
});

test("derives tenant identity from token, never request body", async () => {
  const agentId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  assert.equal((await send("/agent/heartbeat", "student-a", { agentId, userId: "student-b" })).status, 200);
  assert.deepEqual(calls.at(-1), ["heartbeat", "student-a", agentId]);
  assert.equal((await send("/agent/next", "student-b", { agentId, userId: "student-a" })).status, 200);
  assert.deepEqual(calls.at(-1), ["next", "student-b", agentId]);
});

test("rejects cross-site browser requests", async () => {
  const response = await fetch(base + "/agent/heartbeat", { method: "POST", headers: { origin: "https://evil.example", authorization: "Bearer student-a", "content-type": "application/json" }, body: JSON.stringify({ agentId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }) });
  assert.equal(response.status, 403);
});

test("MCP exposes only two tools and binds dispatch to verified user", async () => {
  const client = new Client({ name: "test", version: "1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
    requestInit: { headers: { authorization: "Bearer mcp-a" } },
  });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["get_job_description", "list_eligible_jobs"]);
    const result = await client.callTool({ name: "list_eligible_jobs", arguments: {} });
    assert.equal(result.content[0].text, "test job");
    assert.deepEqual(calls.findLast((call) => call[0] === "dispatch"), ["dispatch", "student-a", "list_eligible_jobs", {}]);
  } finally {
    await client.close();
  }
});
