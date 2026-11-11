import { test } from "node:test";
import assert from "node:assert/strict";
import { callTool, character, connect, esiError, testCtx, withSde } from "./harness.js";
import { STANDARD_SCOPES } from "../auth/scopes.js";

// Own character ids per test file: groups and pending state are per ctx, but keep ids distinct from other files.
const BOSS = character(91000001, "Boss Main");
const ALT1 = character(91000002, "Alt One");
const ALT2 = character(91000003, "Alt Two");
const ALT3 = character(91000004, "Alt Three");

type Member = { character_id: number; access: string };

/** Fake ESI with BOSS managing two access lists; `mains.characters` can be changed between calls. */
function lists() {
  const mains: { characters: Member[] } = {
    characters: [
      { character_id: BOSS.id, access: "Admin" },
      { character_id: ALT1.id, access: "Allowed" },
    ],
  };
  const deploy: { characters: Member[] } = {
    characters: [
      { character_id: BOSS.id, access: "Admin" },
      { character_id: ALT2.id, access: "Allowed" },
      { character_id: ALT3.id, access: "Allowed" },
      { character_id: ALT1.id, access: "Blocked" },
    ],
  };
  const routes = {
    [`GET /characters/${BOSS.id}/access-lists`]: { access_lists: [{ id: 501 }, { id: 502 }] },
    [`GET /characters/${BOSS.id}/access-lists/501`]: () => ({
      id: 501, name: "Main Toons", description: "", membership: { allow_everyone: false, ...mains },
    }),
    [`GET /characters/${BOSS.id}/access-lists/502`]: () => ({
      id: 502, name: "Deployment Toons", description: "staging", membership: { allow_everyone: false, ...deploy },
    }),
  };
  return { mains, deploy, routes };
}

test("link makes a group follow an access list, leaving out blocked and excluded characters", async () => {
  const { routes } = lists();
  const ctx = testCtx({ characters: [BOSS, ALT1, ALT2, ALT3], esi: routes });
  const r = await callTool(ctx, "character_groups", { action: "link", group: "deployment 1", access_list: "deploy", exclude: ["Boss"] });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.json.linked.members, ["Alt Three", "Alt Two"], "Blocked Alt One and excluded Boss Main are left out");
  assert.equal(r.json.linked.follows_access_list, "Deployment Toons (502), read by Boss Main");
  assert.deepEqual(r.json.linked.excluded, ["Boss Main"]);
  assert.equal(
    ctx.esi.callsTo(`/characters/${BOSS.id}/access-lists/502`)[0].opts.scope, "esi-access.read_lists.v1",
  );
});

test("a linked group follows changes made in game, both in tools and in list", async () => {
  const { mains, routes } = lists();
  const ctx = testCtx({ characters: [BOSS, ALT1, ALT2, ALT3], esi: routes });
  await callTool(ctx, "character_groups", { action: "link", group: "mains", access_list: "Main Toons" });
  assert.deepEqual((await ctx.characters(["mains"])).characters.map((c) => c.name), ["Alt One", "Boss Main"]);

  // The user adds Alt Two to the list in game and removes Alt One.
  mains.characters = [{ character_id: BOSS.id, access: "Admin" }, { character_id: ALT2.id, access: "Allowed" }];
  const picked = await ctx.characters(["mains"]);
  assert.deepEqual(picked.characters.map((c) => c.name), ["Alt Two", "Boss Main"]);
  assert.deepEqual(picked.warnings, []);

  const list = await callTool(ctx, "character_groups");
  assert.deepEqual(list.json.groups[0].members, ["Alt Two", "Boss Main"]);
  assert.deepEqual(list.json.not_in_any_group, ["Alt One", "Alt Three"]);
});

test("when the access list can't be read, the group keeps its last members and says why", async () => {
  const { routes } = lists();
  const ctx = testCtx({ characters: [BOSS, ALT1], esi: routes });
  await callTool(ctx, "character_groups", { action: "link", group: "mains", access_list: "501" });
  ctx.esi.routes[`GET /characters/${BOSS.id}/access-lists/501`] = () => { throw esiError(503, "down"); };
  const picked = await ctx.characters(["group:mains"]);
  assert.deepEqual(picked.characters.map((c) => c.name), ["Alt One", "Boss Main"]);
  assert.match(picked.warnings[0], /Group mains: couldn't read access list "Main Toons", using members from .*503/);
});

test("on a linked group, remove excludes a character and add brings them back", async () => {
  const { routes } = lists();
  const ctx = testCtx({ characters: [BOSS, ALT1, ALT2, ALT3], esi: routes });
  const conn = await connect(ctx);
  try {
    await conn.call("character_groups", { action: "link", group: "deployment", access_list: "Deployment Toons" });
    const removed = await conn.call("character_groups", { action: "remove", group: "deployment", characters: ["Boss Main"] });
    assert.deepEqual(removed.json.removed, ["Boss Main"]);
    assert.deepEqual(removed.json.now.members, ["Alt Three", "Alt Two"]);
    assert.deepEqual(removed.json.now.excluded, ["Boss Main"]);

    const notExcluded = await conn.call("character_groups", { action: "add", group: "deployment", characters: ["Alt One"] });
    assert.match(notExcluded.json.skipped[0], /Alt One \(not excluded; to add a character, add them to Deployment Toons in game\)/);

    const back = await conn.call("character_groups", { action: "add", group: "deployment", characters: ["boss"] });
    assert.deepEqual(back.json.added, ["Boss Main"]);
    assert.deepEqual(back.json.now.members, ["Alt Three", "Alt Two", "Boss Main"]);
    assert.equal(back.json.now.excluded, undefined);
    assert.equal(ctx.esi.calls.filter((c) => c.method !== "GET").length, 0, "nothing is written to ESI");
  } finally {
    await conn.close();
  }
});

test("link names the character's access lists when the name doesn't match, and checks exclusions", async () => {
  const { routes } = lists();
  const ctx = testCtx({ characters: [BOSS, ALT1], esi: routes });
  const bad = await callTool(ctx, "character_groups", { action: "link", group: "x", access_list: "Haulers" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /Boss Main manages no access list matching "Haulers".*Main Toons \(501\), Deployment Toons \(502\)/);
  const ex = await callTool(ctx, "character_groups", { action: "link", group: "x", access_list: "Main Toons", exclude: ["Alt Two"] });
  assert.equal(ex.isError, true);
  assert.match(ex.text, /Can't exclude Alt Two: not on Main Toons. On it: Boss Main, Alt One/);
  assert.equal(ctx.groups.list().length, 0, "a failed link creates no group");
});

test("link without the access-list scope says how to get it", async () => {
  const OLD = character(91000009, "Old Login", STANDARD_SCOPES.filter((s) => s !== "esi-access.read_lists.v1"));
  const ctx = testCtx({ characters: [OLD] });
  const r = await callTool(ctx, "character_groups", { action: "access_lists" });
  assert.equal(r.isError, true);
  assert.match(r.text, /Old Login has not granted the scope "esi-access\.read_lists\.v1".*"standard" scope preset/);
});

withSde("access_lists shows each list's characters with their access, and corporations as others", async () => {
  const { routes, deploy } = lists();
  deploy.characters.push({ character_id: 91000099, access: "Manager" });
  const ctx = testCtx({
    characters: [BOSS, ALT2],
    esi: {
      ...routes,
      [`GET /characters/${BOSS.id}/access-lists/502`]: () => ({
        id: 502, name: "Deployment Toons", description: "staging",
        membership: { allow_everyone: false, ...deploy, corporations: [{ corporation_id: 98000123, access: "Allowed" }] },
      }),
      "POST /universe/names": [
        { id: 91000099, name: "Corp Mate", category: "character" },
        { id: ALT1.id, name: "Alt One", category: "character" },
        { id: ALT3.id, name: "Alt Three", category: "character" },
        { id: 98000123, name: "Friendly Corp", category: "corporation" },
      ],
    },
  });
  const r = await callTool(ctx, "character_groups", { action: "access_lists" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.character, "Boss Main");
  const d = r.json.access_lists.find((l: any) => l.name === "Deployment Toons");
  assert.deepEqual(d.characters, ["Boss Main (Admin)", "Alt Two (Allowed)", "Alt Three (Allowed)", "Corp Mate (Manager)"]);
  assert.deepEqual(d.others, ["Friendly Corp"]);

  // Linked, members who aren't logged in here are shown as such and skipped by tools.
  await callTool(ctx, "character_groups", { action: "link", group: "deploy", access_list: "502" });
  const one = await callTool(ctx, "character_groups", { group: "deploy" });
  assert.ok(one.json.members.includes("Corp Mate (not logged in here)"), one.text);
  assert.deepEqual(one.json.also_on_the_list, ["Friendly Corp"]);
  const picked = await ctx.characters(["deploy"]);
  assert.deepEqual(picked.characters.map((c) => c.name), ["Alt Two", "Boss Main"]);
  assert.ok(picked.skipped.includes("Corp Mate (in group deploy, not logged in)"));
});
