#!/usr/bin/env node
// Prints what you need to implement an ESI route, straight from the live OpenAPI spec:
// parameters, request body and response shapes, scope, required in-game roles, rate-limit group,
// pagination and the compatibility date the route appeared in.
//
//   node .claude/skills/adding-eve-tools/scripts/esi-route.mjs "corporations/{corporation_id}/structures"
//   node .claude/skills/adding-eve-tools/scripts/esi-route.mjs "skyhook" --date 2026-08-18
//
// The first argument is matched as a case-insensitive substring of the path (leave off the leading "/":
// Git Bash on Windows rewrites arguments starting with "/" into file paths). --date defaults to
// COMPATIBILITY_DATE from src/config.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const di = args.indexOf("--date");
let date = di >= 0 ? args.splice(di, 2)[1] : undefined;
if (!date) {
  const cfg = readFileSync(fileURLToPath(new URL("../../../../src/config.ts", import.meta.url)), "utf8");
  date = /COMPATIBILITY_DATE = "([\d-]+)"/.exec(cfg)?.[1];
}
// Undo Git Bash's rewrite of "/corporations/..." into "C:/Program Files/Git/corporations/...".
const needle = (args[0] ?? "").toLowerCase().replace(/^[a-z]:\/program files\/git(?=\/)/, "");
if (!needle) {
  console.error("usage: esi-route.mjs <path substring> [--date YYYY-MM-DD]");
  process.exit(2);
}

const res = await fetch(`https://esi.evetech.net/meta/openapi.json?compatibility_date=${date}`, {
  headers: { "X-Compatibility-Date": date, "User-Agent": "eve-esi-mcp skill helper (+https://github.com/apettey/eve-esi-mcp)" },
});
if (!res.ok) throw new Error(`spec download failed: HTTP ${res.status}`);
const spec = await res.json();

const deref = (s) => {
  while (s && s.$ref) s = spec.components[s.$ref.includes("/parameters/") ? "parameters" : "schemas"][s.$ref.split("/").pop()];
  return s;
};
const shape = (s, depth = 0) => {
  s = deref(s);
  if (!s) return "?";
  if (depth > 6) return "…";
  if (s.oneOf) return s.oneOf.map((x) => shape(x, depth + 1)).join(" | ");
  if (s.type === "object") {
    const req = new Set(s.required ?? []);
    return `{${Object.entries(s.properties ?? {}).map(([k, v]) => `${k}${req.has(k) ? "" : "?"}: ${shape(v, depth + 1)}`).join(", ")}}`;
  }
  if (s.type === "array") return `[${shape(s.items, depth + 1)}]`;
  if (s.enum) return s.enum.length <= 12 ? s.enum.join("|") : `${s.type}(${s.enum.length} values)`;
  return s.type ?? "?";
};
const skipParams = new Set(["Accept-Language", "If-None-Match", "X-Compatibility-Date", "X-Tenant", "If-Modified-Since"]);

let found = 0;
for (const [path, ops] of Object.entries(spec.paths)) {
  if (!path.toLowerCase().includes(needle)) continue;
  for (const [method, op] of Object.entries(ops)) {
    if (!["get", "post", "put", "delete"].includes(method)) continue;
    found++;
    const params = (op.parameters ?? []).map(deref).filter((p) => !skipParams.has(p.name));
    const scopes = (op.security ?? []).flatMap((x) => Object.values(x).flat());
    const ok = op.responses?.["200"] ?? op.responses?.["201"] ?? op.responses?.["204"];
    const body = op.requestBody?.content?.["application/json"]?.schema;
    console.log(`\n${method.toUpperCase()} ${path}`);
    if (op.summary || op.description) console.log(`  ${(op.summary ?? op.description).split("\n")[0]}`);
    console.log(`  params:   ${params.map((p) => `${p.name}${p.required ? "" : "?"} (${p.in}): ${shape(p.schema)}`).join(", ") || "-"}`);
    if (body) console.log(`  body:     ${shape(body)}`);
    console.log(`  response: ${ok?.content ? shape(ok.content["application/json"].schema) : "(none)"}`);
    console.log(`  paged:    ${ok?.headers?.["X-Pages"] ? "X-Pages (use ctx.esi.getAllPages)" : params.some((p) => p.name === "from_id") ? "from_id" : params.some((p) => p.name === "after" || p.name === "before") ? "cursor" : "no"}`);
    console.log(`  scope:    ${scopes.join(", ") || "public"}`);
    if (op["x-required-roles"]) console.log(`  roles:    ${op["x-required-roles"].join(", ")} (in-game corporation roles)`);
    if (op["x-rate-limit"]) console.log(`  ratelimit: group ${op["x-rate-limit"].group}, ${op["x-rate-limit"]["max-tokens"]} tokens / ${op["x-rate-limit"]["window-size"]}`);
    if (op["x-compatibility-date"]) console.log(`  since:    compatibility date ${op["x-compatibility-date"]}${op["x-compatibility-date"] > date ? "  (NEWER than the server's date: bump COMPATIBILITY_DATE)" : ""}`);
  }
}
if (!found) console.log(`No route matching "${needle}" at compatibility date ${date}.`);
