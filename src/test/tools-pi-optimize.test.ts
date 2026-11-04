import assert from "node:assert/strict";
import { piData } from "../pi.js";
import {
  CC_LEVELS, extractionColony, factoriesThatFit, optimize, optimizeOnce, pinCosts, type OptimizeParams, type PlanetInput, type Price,
} from "../pi-optimize.js";
import { callTool, character, sde, testCtx, withSde } from "./harness.js";

const JITA_44 = 60003760;
const id = (name: string) => sde!.typeIdByName(name)!;

/** Flat test prices by tier, with deep markets. */
function prices(over: Record<string, number> = {}): Map<number, Price> {
  const pi = piData(sde!);
  const byTier = [0, 500, 12_000, 90_000, 1_600_000];
  const m = new Map<number, Price>();
  for (const [t, tier] of pi.tier) if (tier >= 1) m.set(t, { sell: byTier[tier], dailyVolume: 10_000_000 });
  for (const [name, p] of Object.entries(over)) m.set(id(name), { sell: p, dailyVolume: 10_000_000 });
  return m;
}

const PARAMS: OptimizeParams = {
  yieldAtFull: 8000, taxRate: 0, sellFee: 0.05, liquidityShare: 0.1, maxCharactersPerPlanet: 3, factories: true,
  maxCapitalPerDay: 100_000_000, maxHaulPerDay: 15_000, restockDays: 2, exportRawP0: false,
};

function planet(name: string, type: string, readings: Record<string, number>, pid = 1): PlanetInput {
  const pi = piData(sde!);
  const res = [...pi.p0Planets].filter(([, ts]) => ts.has(type)).map(([r]) => r);
  return { id: pid, name, type, abundance: new Map(res.map((r) => [r, readings[sde!.typeName(r)] ?? 50])) };
}

withSde("extraction colony fits the command center and makes P2 when it pays more than P1", () => {
  const pi = piData(sde!);
  const costs = pinCosts(sde!);
  assert.equal(costs.head.pg, 550, "head powergrid from the SDE");
  const c = { sde: sde!, pi, costs, prices: prices(), params: PARAMS };
  const ice = planet("Test VII", "Ice", { "Aqueous Liquids": 100, "Heavy Metals": 100 });
  const col = extractionColony(c, ice, id("Aqueous Liquids"), id("Heavy Metals"), 5)!;
  assert.ok(col, "a colony fits at CC level 5");
  assert.match(col.describe, /heads per extractor/);
  // With P2 at 12k and P1 at 500, combining wins whenever a P2 exists for the pair (Water + Toxic Metals has none).
  assert.ok(col.outputs.every((o) => pi.tier.get(o.type) === 1), "Water + Toxic Metals has no P2, so both P1 are sold");
  const gas = planet("Test III", "Gas", { "Aqueous Liquids": 60, "Ionic Solutions": 60 });
  const coolant = extractionColony(c, gas, id("Aqueous Liquids"), id("Ionic Solutions"), 5)!;
  assert.ok(coolant.outputs.some((o) => o.type === id("Coolant")), coolant.describe);
  assert.equal(extractionColony(c, gas, id("Aqueous Liquids"), id("Ionic Solutions"), 0), null, "nothing fits a level 0 command center");
  assert.ok(factoriesThatFit(c, id("Nano-Factory"), 5) >= 15, "a level 5 CC holds many High-Tech plants");
  assert.equal(CC_LEVELS.length, 6);
});

withSde("optimize feeds factories from the plan's own colonies before buying", () => {
  const pi = piData(sde!);
  const planets = [
    planet("Test VI", "Barren", { "Noble Metals": 90, "Base Metals": 20 }, 6),
    planet("Test VII", "Ice", { "Heavy Metals": 100, "Aqueous Liquids": 30 }, 7),
  ];
  const plan = optimize(sde!, pi, pinCosts(sde!), prices({ "Enriched Uranium": 30_000 }), planets,
    [{ character: "A", slots: 2, ccLevel: 5 }, { character: "B", slots: 2, ccLevel: 5 }], { ...PARAMS, maxCapitalPerDay: 0 });
  const all = plan.assignments.flatMap((a) => a.colonies);
  const eu = all.find((c) => c.product === id("Enriched Uranium"));
  assert.ok(eu, `an Enriched Uranium factory is planned: ${all.map((c) => c.describe).join(" | ")}`);
  assert.match(eu!.describe, /your colonies' .*(Precious Metals|Toxic Metals)/);
  assert.equal(plan.totals.capitalPerDay, 0, "no input budget, nothing bought");
  for (const a of plan.assignments) {
    const ids = a.colonies.map((c) => c.planet.id);
    assert.equal(new Set(ids).size, ids.length, "one colony per planet per character");
  }
});

withSde("optimize keeps the better of the value and budget-density rankings", () => {
  const pi = piData(sde!);
  const planets = [
    planet("Test I", "Storm", { "Noble Gas": 85, "Ionic Solutions": 60 }, 1),
    planet("Test VI", "Barren", { "Noble Metals": 60, "Base Metals": 65 }, 6),
    planet("Test VII", "Ice", { "Heavy Metals": 100, "Aqueous Liquids": 100 }, 7),
  ];
  const slots = [{ character: "A", slots: 3, ccLevel: 5 }, { character: "B", slots: 3, ccLevel: 5 }];
  const tight = { ...PARAMS, maxHaulPerDay: 3_000 };
  const total = (p: ReturnType<typeof optimize>) => p.assignments.flatMap((a) => a.colonies).reduce((s, c) => s + c.iskPerHour, 0);
  const best = total(optimize(sde!, pi, pinCosts(sde!), prices(), planets, slots, tight));
  for (const mode of ["value", "density"] as const) {
    assert.ok(best >= total(optimizeOnce(sde!, pi, pinCosts(sde!), prices(), planets, slots, tight, mode)) - 1e-6, mode);
  }
});

withSde("optimize respects characters per planet and explains unused slots", () => {
  const pi = piData(sde!);
  const planets = [planet("Test I", "Storm", {}, 1)];
  const plan = optimize(sde!, pi, pinCosts(sde!), prices(), planets,
    [{ character: "A", slots: 1, ccLevel: 5 }, { character: "B", slots: 1, ccLevel: 5 }, { character: "C", slots: 1, ccLevel: 5 }],
    { ...PARAMS, maxCharactersPerPlanet: 1, factories: false });
  assert.equal(plan.assignments.flatMap((a) => a.colonies).length, 1);
  assert.match(plan.unusedReason ?? "", /max_characters_per_planet/);
});

// ---------------------------------------------------------------------------------------------------------------
// The tool

function piCtx(extra: Record<string, unknown> = {}) {
  const pi = piData(sde!);
  const systemId = sde!.systemIdByName("J105443")!;
  const MAIN = character(90200001, "Planner Main");
  const ALT = character(90200002, "Planner Alt");
  const skills = { skills: [
    { skill_id: id("Interplanetary Consolidation"), trained_skill_level: 2, active_skill_level: 2, skillpoints_in_skill: 1 },
    { skill_id: id("Command Center Upgrades"), trained_skill_level: 5, active_skill_level: 5, skillpoints_in_skill: 1 },
  ], total_sp: 2 };
  const attrs = { charisma: 17, intelligence: 21, memory: 21, perception: 21, willpower: 17 };
  const price = (t: number) => [0, 500, 12_000, 90_000, 1_600_000][pi.tier.get(t) ?? 0];
  return testCtx({
    characters: [MAIN, ALT],
    esi: {
      [`/characters/${MAIN.id}/location`]: { solar_system_id: systemId },
      [`/characters/${MAIN.id}/planets`]: [],
      [`/characters/${ALT.id}/planets`]: [],
      [`/characters/${MAIN.id}/skills`]: skills,
      [`/characters/${ALT.id}/skills`]: skills,
      [`/characters/${MAIN.id}/attributes`]: attrs,
      [`/characters/${ALT.id}/attributes`]: attrs,
      "/markets/10000002/orders": (req: any) => [
        { type_id: req.query.type_id, is_buy_order: false, price: price(req.query.type_id), volume_remain: 1_000_000, location_id: JITA_44 },
      ],
      "/markets/10000002/history": () =>
        Array.from({ length: 7 }, (_, i) => ({ date: `2026-11-0${i + 1}`, average: 1, volume: 1_000_000, order_count: 1, highest: 1, lowest: 1 })),
      ...extra,
    },
  });
}

withSde("pi_optimize calibrates yield from a real extractor on a planet with readings", async () => {
  const systemId = sde!.systemIdByName("J105443")!;
  const vii = sde!.planetsInSystem(systemId).find((p) => p.name.endsWith(" VII"))!;
  const now = Date.now();
  const ecu = sde!.typeIdsInGroups([1063])[0];
  const ctx = piCtx({
    "/characters/90200001/planets": [
      { planet_id: vii.id, planet_type: "ice", solar_system_id: systemId, upgrade_level: 5, num_pins: 3, last_update: new Date(now).toISOString() },
    ],
    [`/characters/90200001/planets/${vii.id}`]: {
      links: [], routes: [],
      pins: [{
        pin_id: 1, type_id: ecu, latitude: 0, longitude: 0,
        install_time: new Date(now - 12 * 3600_000).toISOString(), expiry_time: new Date(now + 12 * 3600_000).toISOString(),
        extractor_details: { cycle_time: 900, head_radius: 0.01, product_type_id: id("Heavy Metals"), qty_per_cycle: 10_000, heads: Array.from({ length: 10 }, (_, i) => ({ head_id: i, latitude: 0, longitude: 0 })) },
      }],
    },
  });
  const r = await callTool(ctx, "pi_optimize", { abundance: { VII: { "Heavy Metals": 100 } }, max_input_isk_per_day: 0 });
  assert.equal(r.isError, false, r.text);
  assert.match(r.json.assumptions.p0_per_hour_at_100, /calibrated: median of 1 extractor/);
  assert.doesNotMatch(r.json.assumptions.p0_per_hour_at_100, /^30,000/);
});

withSde("pi_optimize plans every character's slots with readings, totals and assumptions", async () => {
  const r = await callTool(piCtx(), "pi_optimize", {
    abundance: { VII: { "Aqueous": 100, "Heavy Metals": 100 }, "J105443 II": { "Felsic": 80 } },
    max_input_isk_per_day: 0, // no bought inputs: only extraction and factories fed by the plan's own colonies
  });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.system.name, "J105443");
  assert.match(r.json.assumptions.p0_per_hour_at_100, /^30,000 \(default/);
  assert.equal(r.json.plan.length, 2, r.text);
  assert.equal(r.json.totals.input_purchases_per_day, "0.00 ISK");
  assert.ok(r.json.plan.every((p: any) => p.colonies.length === 3), "Interplanetary Consolidation 2 = 3 colonies each");
  assert.match(r.json.totals.isk_per_day, /ISK$/);
  assert.ok(r.json.best_options_by_planet["J105443 VII"].some((s: string) => /Heavy Metals \(100\)|Aqueous Liquids \(100\)/.test(s)));
  assert.ok(r.json.warnings.some((w: string) => /No scan readings for .*J105443 I\b/.test(w)), r.json.warnings.join("\n"));
});

withSde("pi_optimize rejects a resource the planet doesn't have, naming what it has", async () => {
  const r = await callTool(piCtx(), "pi_optimize", { abundance: { VII: { "Felsic Magma": 90 } } });
  assert.equal(r.isError, true);
  assert.match(r.text, /has no resource "Felsic Magma". It has: .*Heavy Metals/);
  const bad = await callTool(piCtx(), "pi_optimize", { abundance: { XX: { Base: 1 } } });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /No planet "XX"/);
});
