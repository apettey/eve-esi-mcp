import { test } from "node:test";
import assert from "node:assert/strict";
import { callTool, esiError, testCtx, withSde } from "./harness.js";

test("server_status reports Tranquility and the static data build", async () => {
  const ctx = testCtx({ sde: null, esi: { "/status": { players: 23456, server_version: "3000000", start_time: "2026-10-28T11:00:00Z" } } });
  const r = await callTool(ctx, "server_status");
  assert.equal(r.json.tranquility.players, 23456);
  assert.deepEqual(r.json.static_data, { status: "test" });
  assert.equal(ctx.esi.callsTo("/status")[0].opts.fresh, true, "status bypasses the cache");
});

test("server_status still answers when ESI is down", async () => {
  const ctx = testCtx({ sde: null, esi: { "/status": () => { throw esiError(503, "down", "/status"); } } });
  const r = await callTool(ctx, "server_status");
  assert.equal(r.isError, false);
  assert.match(r.json.tranquility.error, /503/);
});

withSde("search_items understands shorthand and batches queries", async () => {
  const r = await callTool(testCtx(), "search_items", { queries: ["dc ii", "gila"] });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Damage Control II/);
  assert.match(r.text, /Gila/);
});

withSde("system_info resolves a system by name with security and region", async () => {
  const ctx = testCtx({ esi: {} });
  const r = await callTool(ctx, "system_info", { system: "Jita" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /"Jita"/);
  assert.match(r.text, /The Forge/);
});

withSde("system_info rejects an unknown system", async () => {
  const r = await callTool(testCtx({ esi: {} }), "system_info", { system: "Notasystem Prime" });
  assert.equal(r.isError, true);
});
