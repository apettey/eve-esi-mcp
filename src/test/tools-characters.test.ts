import { test } from "node:test";
import assert from "node:assert/strict";
import { callTool, character, testCtx, withSde } from "./harness.js";

const ALICE = character(90000001, "Alice Alt");
const BOB = character(90000002, "Bob Main", ["esi-skills.read_skills.v1"]);

withSde("characters_list resolves corporation and alliance names", async () => {
  const ctx = testCtx({
    characters: [ALICE, BOB],
    esi: {
      "POST /characters/affiliation": [
        { character_id: ALICE.id, corporation_id: 98000001, alliance_id: 99000001 },
        { character_id: BOB.id, corporation_id: 98000002 },
      ],
      "POST /universe/names": [
        { id: 98000001, name: "Alpha Corp", category: "corporation" },
        { id: 99000001, name: "Alpha Alliance", category: "alliance" },
        { id: 98000002, name: "Bravo Corp", category: "corporation" },
      ],
    },
  });
  const r = await callTool(ctx, "characters_list");
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.active_character, "Alice Alt");
  const alice = r.json.characters.find((c: any) => c.name === "Alice Alt");
  assert.equal(alice.corporation, "Alpha Corp");
  assert.equal(alice.alliance, "Alpha Alliance");
  assert.ok(alice.scopes.includes("skills.read_skills"), "scopes are shortened");
  assert.equal(r.json.characters.find((c: any) => c.name === "Bob Main").alliance, undefined);
});

withSde("characters_list with nobody logged in says how to log in", async () => {
  const r = await callTool(testCtx(), "characters_list");
  assert.equal(r.json.characters, undefined, "empty arrays are dropped by reply()");
  assert.match(r.json.hint, /character_login/);
});

test("character_select accepts a unique part of the name and errors on unknown names", async () => {
  const ctx = testCtx({ characters: [ALICE, BOB] });
  const r = await callTool(ctx, "character_select", { character: "bob" });
  assert.equal(r.json.active_character, "Bob Main");
  assert.equal(ctx.store.activeId, BOB.id);
  const bad = await callTool(ctx, "character_select", { character: "Carol" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /not logged in.*Alice Alt, Bob Main/);
});

test("character_logout revokes the token and moves the active character on", async () => {
  const revoked: number[] = [];
  const ctx = testCtx({
    characters: [ALICE, BOB],
    overrides: { sso: { configured: true, revoke: async (c: { id: number }) => { revoked.push(c.id); } } },
  });
  const r = await callTool(ctx, "character_logout", { character: "Alice Alt" });
  assert.deepEqual(r.json, { removed: "Alice Alt", active_character: "Bob Main" });
  assert.deepEqual(revoked, [ALICE.id]);
});

withSde("a missing scope names the preset that grants it", async () => {
  // Bob only granted skills; the wallet scope is in the standard preset.
  const ctx = testCtx({ characters: [BOB] });
  const r = await callTool(ctx, "wallet", { character: "Bob Main" });
  assert.equal(r.isError, true);
  assert.match(r.text, /Bob Main has not granted the scope "esi-wallet\.read_character_wallet\.v1".*"standard" scope preset/);
});
