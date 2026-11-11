import { test } from "node:test";
import assert from "node:assert/strict";
import { callTool, character, connect, testCtx, withSde } from "./harness.js";

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

const CAROL = character(90000003, "Carol Hauler");

test("character_groups creates, edits, lists and deletes groups", async () => {
  const ctx = testCtx({ characters: [ALICE, BOB, CAROL] });
  const conn = await connect(ctx);
  try {
    const created = await conn.call("character_groups", { action: "create", group: "Home POS", characters: ["alice", "Bob Main"], note: "access list" });
    assert.equal(created.isError, false, created.text);
    assert.deepEqual(created.json.created.members, ["Alice Alt", "Bob Main"]);

    const dup = await conn.call("character_groups", { action: "create", group: "home pos" });
    assert.equal(dup.isError, true);
    assert.match(dup.text, /already exists/);

    const added = await conn.call("character_groups", { action: "add", group: "home pos", characters: ["Carol", "Alice Alt"] });
    assert.deepEqual(added.json.added, ["Carol Hauler"]);
    assert.deepEqual(added.json.skipped, ["Alice Alt (already in it)"]);

    const removed = await conn.call("character_groups", { action: "remove", group: "Home POS", characters: ["bob", "Nobody"] });
    assert.deepEqual(removed.json.removed, ["Bob Main"]);
    assert.deepEqual(removed.json.skipped, ["Nobody (not in the group)"]);
    assert.deepEqual(removed.json.now.members, ["Alice Alt", "Carol Hauler"]);

    const renamed = await conn.call("character_groups", { action: "rename", group: "Home POS", new_name: "Haulers" });
    assert.deepEqual(renamed.json, { renamed: "Home POS", to: "Haulers" });

    const list = await conn.call("character_groups");
    assert.equal(list.json.groups[0].group, "Haulers");
    assert.equal(list.json.groups[0].note, "access list");
    assert.deepEqual(list.json.not_in_any_group, ["Bob Main"]);

    const deleted = await conn.call("character_groups", { action: "delete", group: "group:Haulers" });
    assert.deepEqual(deleted.json, { deleted: "Haulers", had_members: ["Alice Alt", "Carol Hauler"] });
    const none = await conn.call("character_groups", { action: "list", group: "Haulers" });
    assert.equal(none.isError, true);
    assert.match(none.text, /No character group "Haulers".*create/);
  } finally {
    await conn.close();
  }
});

test("character_groups create with an unknown character creates nothing", async () => {
  const ctx = testCtx({ characters: [ALICE] });
  const r = await callTool(ctx, "character_groups", { action: "create", group: "Alts", characters: ["Zed"] });
  assert.equal(r.isError, true);
  assert.match(r.text, /"Zed" is not logged in.*Alice Alt/);
  assert.equal(ctx.groups.list().length, 0);
});

test("a group keeps members who log out, and character lists expand groups to logged-in members", async () => {
  const ctx = testCtx({ characters: [ALICE, BOB, CAROL], overrides: { sso: { configured: true, revoke: async () => {} } } });
  await callTool(ctx, "character_groups", { action: "create", group: "Miners", characters: ["Alice Alt", "Carol Hauler"] });
  await callTool(ctx, "character_logout", { character: "Carol Hauler" });

  const list = await callTool(ctx, "character_groups", { group: "miners" });
  assert.deepEqual(list.json.members, ["Alice Alt", "Carol Hauler (not logged in here)"]);

  const picked = await ctx.characters(["Miners", "Bob Main"]);
  assert.deepEqual(picked.characters.map((c) => c.name), ["Alice Alt", "Bob Main"]);
  assert.deepEqual(picked.skipped, ["Carol Hauler (in group Miners, not logged in)"]);
  await assert.rejects(ctx.characters(["group:Nope"]), /No character group "Nope".*Miners/);

  // A logged-out member can still be removed by name.
  const removed = await callTool(ctx, "character_groups", { action: "remove", group: "Miners", characters: ["Carol Hauler"] });
  assert.deepEqual(removed.json.removed, ["Carol Hauler"]);
});

test("an exact character name wins over a group of the same name", async () => {
  const ctx = testCtx({ characters: [ALICE, BOB] });
  ctx.groups.create("Bob Main");
  ctx.groups.update("Bob Main", (g) => { g.members = [{ id: ALICE.id, name: ALICE.name }]; });
  assert.deepEqual((await ctx.characters(["Bob Main"])).characters.map((c) => c.name), ["Bob Main"]);
  assert.deepEqual((await ctx.characters(["group:Bob Main"])).characters.map((c) => c.name), ["Alice Alt"]);
});

withSde("characters_list shows each character's groups", async () => {
  const ctx = testCtx({ characters: [ALICE, BOB], esi: { "POST /characters/affiliation": [], "POST /universe/names": [] } });
  await callTool(ctx, "character_groups", { action: "create", group: "Scouts", characters: ["Alice Alt"] });
  const r = await callTool(ctx, "characters_list");
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.json.characters.find((c: any) => c.name === "Alice Alt").groups, ["Scouts"]);
  assert.equal(r.json.characters.find((c: any) => c.name === "Bob Main").groups, undefined);
});
