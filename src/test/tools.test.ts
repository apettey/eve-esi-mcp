// Contract tests over every registered tool, plus the coverage ratchet: a new tool can't land without a test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connect, testCtx } from "./harness.js";

/**
 * Tools that predate the tool-test harness and have no handler test yet. This list may only shrink: a new tool
 * needs a test that calls it (callTool(ctx, "name", ...) or conn.call("name", ...)), and the test below fails if a
 * listed tool gains one, so remove it from here when you do.
 */
const UNTESTED = new Set([
  "assets", "character_login", "character_overview", "character_skills", "contracts",
  "doctrine_from_battle_report", "doctrine_from_killmails", "fitting_analyze", "fitting_get", "fitting_save",
  "fittings_list", "industry", "item_info", "killmails", "lookup", "mail_list", "mail_read", "mail_send",
  "market_orders", "market_prices", "notifications", "planets", "route_plan", "ship_fitting", "skill_check",
  "wormhole_type",
]);

/** Tools that change the account or game client. Their descriptions must tell the model to confirm first. */
const GAME_WRITES = ["fitting_save", "fitting_delete", "mail_send", "ui_action", "route_plan", "esi_request"];

async function listTools() {
  const conn = await connect(testCtx({ sde: null }));
  try {
    return (await conn.client.listTools()).tools;
  } finally {
    await conn.close();
  }
}

test("every tool has a title, a real description and annotations", async () => {
  const tools = await listTools();
  assert.ok(tools.length >= 30, `only ${tools.length} tools registered`);
  for (const t of tools) {
    assert.match(t.name, /^[a-z][a-z_]*$/, `${t.name}: snake_case name`);
    assert.ok(t.title, `${t.name}: title`);
    assert.ok((t.description ?? "").length >= 60, `${t.name}: description should say what question it answers`);
    assert.ok(t.annotations, `${t.name}: annotations (READ_ONLY for reads, openWorldHint for writes)`);
  }
});

test("write tools are not marked read-only and say to confirm with the user", async () => {
  const tools = new Map((await listTools()).map((t) => [t.name, t]));
  for (const name of GAME_WRITES) {
    const t = tools.get(name);
    assert.ok(t, `${name} is registered`);
    assert.notEqual(t.annotations?.readOnlyHint, true, `${name}: not readOnlyHint`);
    assert.equal(t.annotations?.openWorldHint, true, `${name}: openWorldHint`);
    assert.match(t.description ?? "", /confirm/i, `${name}: description tells the model to confirm first`);
  }
  for (const t of tools.values()) {
    if (t.annotations?.readOnlyHint) continue;
    assert.ok(
      GAME_WRITES.includes(t.name) || t.name.startsWith("character_"),
      `${t.name} is not read-only: add it to GAME_WRITES (and say "confirm" in its description) or mark it READ_ONLY`,
    );
  }
});

test("every tool has a handler test (UNTESTED may only shrink)", async () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith(".test.js") && f !== "tools.test.js")
    .map((f) => readFileSync(dir + f, "utf8"))
    .join("\n");
  const called = (name: string) => new RegExp(`(callTool\\([^"\\n]*|\\.call\\(\\s*)"${name}"`).test(sources);
  const names = (await listTools()).map((t) => t.name);
  const missing = names.filter((n) => !called(n) && !UNTESTED.has(n));
  assert.deepEqual(missing, [], `tools without a handler test (see the testing-eve-esi skill): ${missing.join(", ")}`);
  const nowTested = [...UNTESTED].filter(called);
  assert.deepEqual(nowTested, [], `remove from UNTESTED in tools.test.ts, they have tests now: ${nowTested.join(", ")}`);
  const unknown = [...UNTESTED].filter((n) => !names.includes(n));
  assert.deepEqual(unknown, [], `UNTESTED names no registered tool: ${unknown.join(", ")}`);
});
