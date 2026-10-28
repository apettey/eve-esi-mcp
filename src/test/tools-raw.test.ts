import { test } from "node:test";
import assert from "node:assert/strict";
import { callTool, character, testCtx, withSde } from "./harness.js";

const PILOT = character(90000201, "Raw Pilot");

withSde("esi_request fills placeholders, authenticates character routes and resolves names", async () => {
  const ctx = testCtx({
    characters: [PILOT],
    esi: {
      [`/characters/${PILOT.id}`]: { corporation_id: 98000201, name: "Raw Pilot" },
      "/corporations/98000201/standings": [{ from_id: 500001, from_type: "faction", standing: 5.5 }],
      "POST /universe/names": [{ id: 500001, name: "Caldari State", category: "faction" }],
    },
  });
  const r = await callTool(ctx, "esi_request", { path: "/corporations/{corporation_id}/standings" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.path, "/corporations/98000201/standings");
  assert.match(r.text, /Caldari State/);
  assert.equal(ctx.esi.callsTo("/corporations/98000201/standings")[0].opts.character?.id, PILOT.id);
});

test("esi_request rejects relative paths and unfilled placeholders before calling ESI", async () => {
  const ctx = testCtx({ characters: [PILOT], sde: null });
  assert.match((await callTool(ctx, "esi_request", { path: "status" })).text, /must start with/);
  assert.match((await callTool(ctx, "esi_request", { path: "/universe/types/{type_id}" })).text, /Unfilled path parameter/);
  assert.deepEqual(ctx.esi.calls, []);
});

withSde("ui_action opens the market window for a fuzzy item name", async () => {
  const ctx = testCtx({ characters: [PILOT], esi: { "POST /ui/openwindow/marketdetails": null } });
  const r = await callTool(ctx, "ui_action", { action: "open_market", target: "dc ii" });
  assert.deepEqual(r.json, { done: "open_market", item: "Damage Control II", character: "Raw Pilot" });
  const call = ctx.esi.callsTo("/ui/openwindow/marketdetails")[0];
  assert.equal(call.opts.scope, "esi-ui.open_window.v1");
  assert.ok(Number(call.opts.query?.type_id) > 0);
});

test("ui_action needs a logged-in character", async () => {
  const r = await callTool(testCtx({ sde: null }), "ui_action", { action: "open_info", target: 1 });
  assert.equal(r.isError, true);
  assert.match(r.text, /character_login/);
});
