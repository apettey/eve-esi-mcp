import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piData } from "../pi.js";
import { defaultTemplateFolder } from "../pi-plan.js";
import { callTool, character, sde, testCtx, withSde } from "./harness.js";
import { checkTemplate } from "./pi-template-check.js";

const JITA_44 = 60003760;
const id = (name: string) => sde!.typeIdByName(name)!;

function planCtx() {
  const pi = piData(sde!);
  const systemId = sde!.systemIdByName("J105443")!;
  const MAIN = character(90500001, "Plan Main");
  const ALT = character(90500002, "Plan Alt");
  const skills = { skills: [
    { skill_id: id("Interplanetary Consolidation"), trained_skill_level: 2, active_skill_level: 2, skillpoints_in_skill: 1 },
    { skill_id: id("Command Center Upgrades"), trained_skill_level: 5, active_skill_level: 5, skillpoints_in_skill: 1 },
  ], total_sp: 2 };
  const attrs = { charisma: 17, intelligence: 21, memory: 21, perception: 21, willpower: 17 };
  const price = (t: number) => [0, 500, 12_000, 90_000, 1_600_000][pi.tier.get(t) ?? 0];
  const esi: Record<string, unknown> = {
    "/markets/10000002/orders": (req: any) => [
      { type_id: req.query.type_id, is_buy_order: false, price: price(req.query.type_id), volume_remain: 1_000_000, location_id: JITA_44 },
    ],
    "/markets/10000002/history": () =>
      Array.from({ length: 7 }, (_, i) => ({ date: `2026-11-0${i + 1}`, average: 1, volume: 1_000_000, order_count: 1, highest: 1, lowest: 1 })),
  };
  for (const c of [MAIN, ALT]) {
    esi[`/characters/${c.id}/location`] = { solar_system_id: systemId };
    esi[`/characters/${c.id}/planets`] = [];
    esi[`/characters/${c.id}/skills`] = skills;
    esi[`/characters/${c.id}/attributes`] = attrs;
  }
  return testCtx({ characters: [MAIN, ALT], esi });
}

const ARGS = { abundance: { VII: { "Aqueous": 100, "Heavy Metals": 100 }, "J105443 II": { "Felsic": 80 } }, max_input_isk_per_day: 0 };

withSde("a saved plan gives the same sheets and templates every time, without fetching prices", async () => {
  const ctx = planCtx();
  const none = await callTool(ctx, "pi_plans", { name: "anything" });
  assert.equal(none.isError, true);
  assert.match(none.text, /No saved PI plans yet\. Run pi_optimize with `save_as`/);

  const opt = await callTool(ctx, "pi_optimize", { ...ARGS, save_as: "Home plan", templates: true });
  assert.equal(opt.isError, false, opt.text);
  assert.equal(opt.json.saved_as.name, "Home plan");
  const planned = opt.json.plan.reduce((n: number, p: any) => n + p.colonies.length, 0);

  const list = await callTool(ctx, "pi_plans", {});
  assert.equal(list.json.plans.length, 1);
  assert.equal(list.json.plans[0].name, "Home plan");
  assert.equal(list.json.plans[0].system, "J105443");
  assert.equal(list.json.plans[0].colonies, planned);

  const before = ctx.esi.calls.length;
  const a = await callTool(ctx, "pi_plans", { name: "home PLAN", templates: true });
  const b = await callTool(ctx, "pi_plans", { name: "Home plan", templates: true });
  assert.equal(a.isError, false, a.text);
  assert.equal(ctx.esi.calls.length, before, "a saved plan needs no ESI (prices are frozen in it)");
  assert.equal(a.text, b.text, "same output every time");
  assert.deepEqual(a.texts, b.texts);
  assert.deepEqual(a.texts, opt.texts, "the same templates pi_optimize gave when it saved");
  assert.equal(a.json.colonies.length, planned);
  assert.equal(a.json.sheets.length, planned);
  for (const line of a.json.colonies) assert.match(line, /^Plan (Main|Alt): J105443 [IVX]+ \(\w+\) .* Template "J105443 [IVX]+ - .+\.json" \(\d+ structures, \d+ links, \d+ km\)$/);
  for (const t of a.texts) checkTemplate(JSON.parse(t));
  assert.ok(a.json.haul_per_trip.take_out_and_sell.length > 0);
  // The routine for every undock: one run per character, each step a planet (or docking) with where things go.
  const runs = a.json.routine.runs;
  assert.deepEqual(runs.map((x: any) => x.character).sort(), ["Plan Alt", "Plan Main"]);
  for (const run of runs) {
    assert.equal(run.every, "day");
    assert.match(run.cargo_m3, /^[\d,]+/);
    assert.ok(run.steps.some((s: string) => /^[IVX]+ \(\w+\): restart the extractor programs/.test(s)), run.steps.join(" | "));
  }
  const quiet = await callTool(ctx, "pi_plans", { name: "Home plan", routine: false, sheets: false });
  assert.equal(quiet.json.routine, undefined);

  const alt = await callTool(ctx, "pi_plans", { name: "Home plan", characters: ["plan alt"], sheets: false });
  assert.ok(alt.json.colonies.every((l: string) => l.startsWith("Plan Alt: ")));
  assert.equal(alt.json.sheets, undefined);
  const nobody = await callTool(ctx, "pi_plans", { name: "Home plan", characters: ["Nobody"] });
  assert.match(nobody.text, /no colonies for Nobody\. Characters in it: /);
  // check: nothing built yet in the fake ESI, so every planned colony says so.
  const check = await callTool(ctx, "pi_plans", { name: "Home plan", check: true, characters: ["Plan Main"] });
  assert.equal(check.isError, false, check.text);
  assert.equal(check.json.summary, `0 of 1 characters match the plan; ${a.json.colonies.filter((l: string) => l.startsWith("Plan Main")).length} issues`);
  assert.equal(check.json.characters[0].character, "Plan Main");
  assert.match(check.json.characters[0].built, /^0 of \d+ colonies$/);
  for (const line of check.json.characters[0].colonies) assert.match(line, /^[IVX]+ \(\w+\): not built yet$/);
  assert.equal(ctx.esi.callsTo("/characters/90500001/planets").at(-1)!.opts.scope, "esi-planets.manage_planets.v1");
  assert.equal(check.json.routine, undefined, "check answers only the check");
  const unknown = await callTool(ctx, "pi_plans", { name: "Other" });
  assert.match(unknown.text, /No saved plan "Other"\. Saved plans: Home plan\./);
});

withSde("pi_plan_export writes one template per colony and a build book", async () => {
  const ctx = planCtx();
  await callTool(ctx, "pi_optimize", { ...ARGS, save_as: "Home plan" });
  const folder = mkdtempSync(join(tmpdir(), "pi-templates-"));
  const r = await callTool(ctx, "pi_plan_export", { folder });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.plan, "Home plan", "the latest plan by default");
  assert.equal(r.json.folder, folder);
  const files = readdirSync(folder);
  assert.equal(files.filter((f) => f.endsWith(".json")).length, r.json.templates_written.length);
  for (const f of r.json.templates_written) {
    const text = readFileSync(join(folder, f), "utf8");
    assert.match(text, /^\{"CmdCtrLv": \d, "Cmt": .*"Diam": \d+\.\d+, "L": \[/, "written the way the client writes templates");
    assert.ok(!text.includes("\n"), "one line");
    const t = JSON.parse(text);
    checkTemplate(t);
    assert.equal(`${t.Cmt}.json`, f);
  }
  assert.equal(r.json.build_book, join(folder, "Home plan.md"));
  const book = readFileSync(r.json.build_book, "utf8");
  assert.match(book, /^# Home plan\n\nJ105443, saved \d{4}-\d\d-\d\d/);
  assert.match(book, /## Build sheets/);
  for (const f of r.json.templates_written) assert.ok(book.includes(`\`${f}\``), `the book names ${f}`);
  assert.equal(r.json.replaced, undefined);
  assert.equal(ctx.esi.calls.filter((c: any) => c.method !== "GET").length, 0, "nothing sent to ESI");

  const again = await callTool(ctx, "pi_plan_export", { folder, build_book: false, characters: ["Plan Main"] });
  assert.ok(again.json.replaced >= 1);
  assert.equal(again.json.build_book, undefined);
  assert.ok(existsSync(join(folder, "Home plan.md")));

  // A folder it can't write to (here: under a file) says what to do instead of a raw file-system error.
  const blocker = join(folder, "not-a-folder");
  writeFileSync(blocker, "");
  const blocked = await callTool(ctx, "pi_plan_export", { folder: join(blocker, "templates") });
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /^Couldn't write to .*not-a-folder.*Controlled Folder Access.*Explorer.*Load from clipboard/s);
});

withSde("pi_plan_export finds the client's template folder, under Documents or OneDrive", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-home-"));
  const docs = join(home, "Documents", "EVE", "PlanetaryInteractionTemplates");
  const one = join(home, "OneDrive", "Documents", "EVE", "PlanetaryInteractionTemplates");
  assert.equal(defaultTemplateFolder(home), docs, "nothing there yet: Documents");
  mkdirSync(join(one, ".."), { recursive: true });
  assert.equal(defaultTemplateFolder(home), one, "only OneDrive has an EVE folder");
  mkdirSync(docs, { recursive: true });
  assert.equal(defaultTemplateFolder(home), docs, "the template folder that exists wins over an EVE folder without one");
});
