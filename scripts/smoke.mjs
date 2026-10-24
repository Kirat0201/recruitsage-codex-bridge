import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = fileURLToPath(new URL("../src/server.mjs", import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
const client = new Client({ name: "recruitsage-smoke", version: "0.1.0" });

function parseResult(result) {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("MCP tool returned no text.");
  if (result.isError) throw new Error(text.split("\n")[0]);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`MCP tool returned non-JSON text: ${text.split("\n")[0]}`);
  }
}

try {
  await client.connect(transport);
  const list = parseResult(await client.callTool({ name: "list_eligible_jobs", arguments: {} }));
  console.log(`Eligible jobs: ${list.count}`);
  for (const job of list.jobs) {
    const details = parseResult(await client.callTool({ name: "get_job_description", arguments: { url: job.url } }));
    console.log(`${job.url}: detail text ${details.bodyText.length} chars; documents ${details.documents.length}`);
    for (const document of details.documents) {
      console.log(`  ${document.filename ?? "Drive document"}: ${document.text?.length ?? 0} chars${document.error ? ` (${document.stage ?? "download"}: ${document.errorType ?? document.error})` : ""}`);
    }
  }
} finally {
  await client.close();
}
