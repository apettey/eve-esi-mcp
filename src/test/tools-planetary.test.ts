import assert from "node:assert/strict";
import { STANDARD_SCOPES } from "../auth/scopes.js";
import { balancedChain, makeableOn, minimalPlanetSets, piData, rawInputs } from "../pi.js";
import { callTool, character, sde, testCtx, withSde } from "./harness.js";

const id = (name: string) => {
  const t = sde!.typeIdByName(name);
  assert.ok(t, `type ${name}`);
  return t!;
};

// ---------------------------------------------------------------------------------------------------------------
// PI model from the SDE

withSde("PI model: planet types, P0 matrix and schematics come from the SDE", () => {
  const pi = piData(sde!);
  assert.deepEqual(pi.planetTypes, ["Barren", "Gas", "Ice", "Lava", "Oceanic", "Plasma", "Storm", "Temperate"]);
  assert.equal(pi.schematic.size, 68);
  assert.deepEqual([...pi.highTech].sort(), ["Barren", "Temperate"], "P4 factories only on Barren and Temperate");
  assert.deepEqual([...pi.p0Planets.get(id("Autotrophs"))!], ["Temperate"]);
  assert.deepEqual([...pi.p0Planets.get(id("Felsic Magma"))!], ["Lava"]);
  assert.deepEqual([...pi.p0Planets.get(id("Reactive Gas"))!], ["Gas"]);
  for (const p of pi.planetTypes) {
    assert.equal([...pi.p0Planets.values()].filter((s) => s.has(p)).length, 5, `${p} has 5 resources`);
  }
});

withSde("PI model: chain math, raw inputs and minimal planet sets", () => {
  const pi = piData(sde!);
  assert.deepEqual([...rawInputs(pi, id("Mechanical Parts"))].map((t) => sde!.typeName(t)).sort(), ["Base Metals", "Noble Metals"]);
  assert.ok(makeableOn(pi, id("Robotics"), ["Plasma"]));
  assert.ok(!makeableOn(pi, id("Nano-Factory"), ["Storm", "Gas"]), "P4 needs a High-Tech planet type");
  assert.deepEqual(minimalPlanetSets(pi, id("Nano-Factory")), [["Storm", "Temperate"]]);
  assert.deepEqual(minimalPlanetSets(pi, id("Microfiber Shielding")), [["Lava", "Temperate"]]);

  const p2 = balancedChain(pi, id("Coolant"));
  assert.equal(p2.factories.get(id("Water")), 1, "one basic per P1 input of a P2 factory");
  assert.equal(p2.p0PerHour.get(id("Aqueous Liquids")), 6000);
  const p4 = balancedChain(pi, id("Nano-Factory"));
  assert.equal(p4.factories.get(id("Industrial Explosives")), 2);
  assert.equal(p4.factories.get(id("Reactive Metals")), 1, "Nano-Factory's direct P1 input");
});

// ---------------------------------------------------------------------------------------------------------------
// pi_product

withSde("pi_product explains a P4 chain with planets, factories and tax", async () => {
  const r = await callTool(testCtx({ esi: {} }), "pi_product", { products: ["nano-factory", "Base Metals"], tax_rate_pct: 10 });
  assert.equal(r.isError, false, r.text);
  const [nano, p0] = r.json.products;
  assert.equal(nano.product, "Nano-Factory");
  assert.equal(nano.tier, "P4");
  assert.match(nano.factory, /High-Tech Production Plant \(Barren or Temperate only\)/);
  assert.equal(nano.fewest_planet_types, "2: Storm + Temperate");
  assert.equal(nano.export_tax_per_unit, "120.00k ISK");
  assert.ok(nano.raw_materials.includes("Autotrophs (Temperate)"));
  assert.ok(nano.balanced_chain.some((s: string) => /^2 x Industrial Explosives \(P3, 3\/h each\)$/.test(s)), nano.balanced_chain.join("\n"));
  assert.ok(nano.used_in_industry.length > 0);
  assert.equal(p0.tier, "P0");
  assert.ok(p0.found_on.includes("Gas"));
});

withSde("pi_product rejects items that are not planetary commodities", async () => {
  const r = await callTool(testCtx({ esi: {} }), "pi_product", { products: ["Rifter"] });
  assert.equal(r.isError, true);
  assert.match(r.text, /Rifter is not a planetary commodity/);
});

// ---------------------------------------------------------------------------------------------------------------
// pi_system_planets

withSde("pi_system_planets flags shattered planets and supports what-if planet types", async () => {
  const r = await callTool(testCtx({ esi: {} }), "pi_system_planets", { system: "Thera", include_characters: false });
  assert.equal(r.isError, false, r.text);
  assert.ok(r.json.planets.includes("Thera I: Shattered (no PI)"));
  assert.ok(r.json.planets.some((p: string) => /: Plasma$/.test(p)));
  assert.match(r.json.p4_factory_possible, /^no: P4 needs a Barren or Temperate planet/);
  assert.ok(r.json.one_planet_type_short.some((s: string) => /^Nano-Factory \(P4\): add .*Temperate/.test(s)), r.text);

  const what = await callTool(testCtx({ esi: {} }), "pi_system_planets", { system: "Thera", extra_planet_types: ["temperate"], include_characters: false });
  assert.equal(what.isError, false, what.text);
  assert.deepEqual(what.json.what_if_planet_types, ["Temperate"]);
  assert.match(what.json.p4_factory_possible, /^yes/);
});

withSde("pi_system_planets defaults to the character's system and covers every alt", async () => {
  const systemId = sde!.systemIdByName("J105443")!;
  const planet = sde!.planetsInSystem(systemId)[0];
  const ic = id("Interplanetary Consolidation");
  const ccu = id("Command Center Upgrades");
  const MAIN = character(90100001, "PI Main");
  const ALT = character(90100002, "PI Alt");
  const NOSCOPE = character(90100003, "Scopeless Alt", STANDARD_SCOPES.filter((s) => s !== "esi-planets.manage_planets.v1"));
  const UNTRAINED = character(90100004, "Untrained Alt");
  const skills = (lvl: number, cc = 4) => ({
    skills: [
      { skill_id: ic, trained_skill_level: lvl, active_skill_level: lvl, skillpoints_in_skill: 1 },
      { skill_id: ccu, trained_skill_level: cc, active_skill_level: cc, skillpoints_in_skill: 1 },
    ],
    total_sp: 2,
  });
  const attrs = { charisma: 17, intelligence: 21, memory: 21, perception: 21, willpower: 17 };
  const ctx = testCtx({
    characters: [MAIN, ALT, NOSCOPE, UNTRAINED],
    esi: {
      [`/characters/${MAIN.id}/location`]: { solar_system_id: systemId },
      [`/characters/${MAIN.id}/planets`]: [
        { planet_id: planet.id, planet_type: "barren", solar_system_id: systemId, upgrade_level: 4, num_pins: 9, last_update: "2026-11-01T00:00:00Z" },
        { planet_id: 40000002, planet_type: "temperate", solar_system_id: 30000001, upgrade_level: 5, num_pins: 12, last_update: "2026-11-01T00:00:00Z" },
      ],
      [`/characters/${ALT.id}/planets`]: [],
      [`/characters/${MAIN.id}/skills`]: skills(5),
      [`/characters/${ALT.id}/skills`]: skills(3),
      [`/characters/${NOSCOPE.id}/skills`]: skills(0),
      [`/characters/${MAIN.id}/attributes`]: attrs,
      [`/characters/${ALT.id}/attributes`]: attrs,
      [`/characters/${NOSCOPE.id}/attributes`]: attrs,
      [`/characters/${UNTRAINED.id}/planets`]: [],
      [`/characters/${UNTRAINED.id}/skills`]: skills(0, 0),
      [`/characters/${UNTRAINED.id}/attributes`]: attrs,
    },
  });
  const r = await callTool(ctx, "pi_system_planets", {});
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.system.name, "J105443");
  assert.equal(r.json.system.wormhole_class, "C1");
  const byName = Object.fromEntries(r.json.characters.map((c: any) => [c.character, c]));
  assert.deepEqual(byName["PI Main"].colonies_here, [`${planet.name} (barren, CC level 4, 9 pins)`]);
  assert.equal(byName["PI Main"].free_slots, 4);
  assert.equal(byName["PI Main"].max_command_center_level, 4);
  assert.equal(byName["PI Alt"].free_slots, 4);
  assert.match(byName["Scopeless Alt"].note, /esi-planets\.manage_planets\.v1/, "missing scope is reported, not fatal");
  assert.equal(byName["Scopeless Alt"].max_colonies, 1);
  assert.deepEqual(byName["PI Main"].colonies_elsewhere, [`${sde!.system(30000001)!.name} (1)`]);
  assert.equal(r.json.characters[0].character, "PI Main", "characters with colonies here come first");
  assert.equal(r.json.free_colony_slots_total, 8);
  assert.deepEqual(r.json.no_pi_skills, ["Untrained Alt"], "alts with no PI skills are named, not counted");
});

withSde("pi_system_planets rejects an unknown what-if planet type with the valid list", async () => {
  const r = await callTool(testCtx({ esi: {} }), "pi_system_planets", { system: "Thera", extra_planet_types: ["Desert"], include_characters: false });
  assert.equal(r.isError, true);
  assert.match(r.text, /Planet types with PI: Barren, Gas/);
});
