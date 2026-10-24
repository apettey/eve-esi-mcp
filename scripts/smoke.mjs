#!/usr/bin/env node
// Drives the built server (dist/index.js) over stdio like a real MCP client and prints each tool result.
//
//   node scripts/smoke.mjs '[["search_items",{"queries":"dc ii"}],["system_info",{"system":"Jita"}]]'
//   node scripts/smoke.mjs --home ~/.eve-esi-mcp --max 4000 --calls calls.json
//
// Options:
//   --home <dir>     EVE_ESI_MCP_HOME for the server (default: the server's own default, ~/.eve-esi-mcp)
//   --max <n>        truncate each printed result to n characters (default 3000; 0 = no limit)
//   --calls <file>   read the call list from a JSON file instead of the first positional argument
//   --json           print one JSON object per call ({tool, args, ms, isError, content}) for scripting
//   --list           also print the registered tool names
// Every other environment variable (EVE_CLIENT_ID, EVE_FIT_COMMAND, ...) is passed through to the server.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args.splice(i, 1), true) : false;
};
const home = opt("--home");
const max = Number(opt("--max") ?? 3000);
const callsFile = opt("--calls");
const asJson = flag("--json");
const list = flag("--list");
const calls = JSON.parse(callsFile ? readFileSync(callsFile, "utf8") : args[0] ?? "[]");

const server = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const env = { ...process.env, EVE_OPEN_BROWSER: process.env.EVE_OPEN_BROWSER ?? "false" };
if (home) env.EVE_ESI_MCP_HOME = home;

const client = new Client({ name: "eve-esi-smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env, stderr: "inherit" }));
if (list) console.log("TOOLS", (await client.listTools()).tools.map((t) => t.name).join(", "));

let failed = 0;
for (const [tool, toolArgs = {}] of calls) {
  const t0 = Date.now();
  let result;
  try {
    result = await client.callTool({ name: tool, arguments: toolArgs });
  } catch (err) {
    result = { isError: true, content: [{ type: "text", text: String(err?.message ?? err) }] };
  }
  const ms = Date.now() - t0;
  const text = result.content.map((c) => c.text ?? `[${c.type}]`).join("\n---\n");
  if (result.isError) failed++;
  if (asJson) console.log(JSON.stringify({ tool, args: toolArgs, ms, isError: !!result.isError, content: text }));
  else console.log(`\n### ${tool} ${JSON.stringify(toolArgs).slice(0, 160)} (${ms}ms)${result.isError ? " ERROR" : ""}\n${max ? text.slice(0, max) : text}`);
}
await client.close();
process.exit(failed ? 1 : 0);
