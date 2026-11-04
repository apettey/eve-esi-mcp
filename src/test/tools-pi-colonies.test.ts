import { test } from "node:test";
import assert from "node:assert/strict";
import { STANDARD_SCOPES } from "../auth/scopes.js";
import { piData } from "../pi.js";
import { analyzeColony, cycleOutput, extractorProgram, programCycleSeconds, programFactor, yieldAt100 } from "../pi-colony.js";
import { callTool, character, sde, testCtx, withSde } from "./harness.js";

const H = 3_600_000;
const id = (name: string) => sde!.typeIdByName(name)!;
const iso = (ms: number) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------------------------------------------
// Extractor curve

test("extractor output decays over the program and stops at expiry", () => {
  const first = cycleOutput(10_000, 0, 900);
  const late = cycleOutput(10_000, 90, 900);
  assert.ok(first > 0 && late > 0);
  assert.ok(late < first, `later cycles give less (${late} < ${first})`);

  const now = Date.parse("2026-11-04T12:00:00Z");
  const p = extractorProgram(10_000, 900, now - 12 * H, now + 12 * H, now);
  assert.equal(p.cycles, 96, "24 h of 15-minute cycles");
  assert.equal(p.done + p.remaining, p.total);
  assert.ok(Math.abs(p.avgPerHour - p.total / 24) < 1e-6);
  assert.ok(p.nowPerHour > 0);
  assert.equal(extractorProgram(10_000, 900, now - 48 * H, now - 24 * H, now).nowPerHour, 0, "an expired program makes nothing");
});

test("program length sets the cycle and lowers output per hour", () => {
  assert.equal(programCycleSeconds(1), 900);
  assert.equal(programCycleSeconds(24), 900, "observed: one-day programs run 15-minute cycles");
  assert.equal(programCycleSeconds(48), 1800);
  assert.equal(programCycleSeconds(96), 3600);
  assert.equal(programCycleSeconds(336), 14400);
  assert.equal(programFactor(24), 1);
  assert.ok(programFactor(12) > 1, "shorter than a day: more per hour");
  let last = 1;
  for (const h of [48, 96, 168, 336]) {
    const f = programFactor(h);
    assert.ok(f < last, `${h} h: ${f}`);
    last = f;
  }
  // The factor matches the full curve (noise included) to within a few percent.
  const day = extractorProgram(10_000, 900, 0, 24 * H, 0).avgPerHour;
  const four = extractorProgram(10_000, 3600, 0, 96 * H, 0).avgPerHour;
  assert.ok(Math.abs(four / day - programFactor(96)) < 0.1, `${four / day} vs ${programFactor(96)}`);
});

// ---------------------------------------------------------------------------------------------------------------
// Colony analysis from an ESI layout

function layout(now: number) {
  const pi = piData(sde!);
  const sch = (product: string) => pi.schematic.get(id(product))!.id;
  const g = (group: number) => sde!.typeIdsInGroups([group])[0];
  const heads = (n: number) => Array.from({ length: n }, (_, i) => ({ head_id: i, latitude: 0, longitude: 0 }));
  const route = (route_id: number, source_pin_id: number, destination_pin_id: number, type: string, quantity: number) =>
    ({ route_id, source_pin_id, destination_pin_id, content_type_id: id(type), quantity });
  return {
    links: [],
    routes: [
      route(1, 2, 1, "Aqueous Liquids", 3_000), // extractor -> launchpad
      route(2, 1, 3, "Aqueous Liquids", 3_000), // launchpad -> Water factory
      route(3, 3, 1, "Water", 20), // Water -> launchpad
      route(4, 1, 4, "Water", 40), // launchpad -> Coolant (nothing brings Electrolytes)
    ],
    pins: [
      { pin_id: 1, type_id: g(1030), latitude: 0, longitude: 0, contents: [{ type_id: id("Water"), amount: 10_000 }] }, // launchpad: 1,900 m3
      {
        pin_id: 2, type_id: g(1063), latitude: 0, longitude: 0, install_time: iso(now - 2 * H), expiry_time: iso(now + 3 * H),
        extractor_details: { cycle_time: 900, head_radius: 0.01, product_type_id: id("Aqueous Liquids"), qty_per_cycle: 3_000, heads: heads(8) },
      },
      // Basic factory on Water, running.
      { pin_id: 3, type_id: g(1028), latitude: 0, longitude: 0, schematic_id: sch("Water"), last_cycle_start: iso(now - 0.2 * H) },
      // Advanced factory on Coolant: needs Electrolytes, which nothing here makes; idle for a day.
      { pin_id: 4, type_id: g(1028), latitude: 0, longitude: 0, factory_details: { schematic_id: sch("Coolant") }, last_cycle_start: iso(now - 24 * H) },
    ],
  };
}

withSde("analyzeColony reads extractors, factories, shortfalls and storage", () => {
  const now = Date.parse("2026-11-04T12:00:00Z");
  const a = analyzeColony(sde!, piData(sde!), layout(now), now);
  assert.equal(a.extractors.length, 1);
  assert.equal(a.extractors[0].heads, 8);
  assert.ok(a.extractors[0].program!.nowPerHour > 0);
  assert.equal(a.factories.get(id("Coolant")), 1);
  assert.equal(a.idleFactories.get(id("Coolant")), 1, "a factory with no cycle for a day is idle");
  assert.equal(a.idleFactories.get(id("Water")), undefined);
  assert.ok(a.shortfalls.some((s) => s.type === id("Electrolytes") && s.have === 0));
  assert.deepEqual(a.unroutedInputs, [{ product: id("Coolant"), input: id("Electrolytes"), factories: 1 }]);
  assert.deepEqual(a.unroutedOutputs, [{ type: id("Coolant"), from: "factory", pins: 1 }]);
  assert.equal(a.capacityM3, 10_000);
  assert.ok(Math.abs(a.storedM3 - 1900) < 1);
  const y = yieldAt100(a.extractors[0], 50)!;
  assert.ok(Math.abs(y - (a.extractors[0].program!.avgPerHour * (10 / 8) * 2) / programFactor(5)) < 1e-6,
    "scaled to 10 heads, a reading of 100 and from its 5-hour program to one day");
});

withSde("analyzeColony follows routes: unrouted inputs stop a factory, direct feeds cap it", () => {
  const now = Date.parse("2026-11-04T12:00:00Z");
  const pi = piData(sde!);
  const g = (group: number) => sde!.typeIdsInGroups([group])[0];
  const water = pi.schematic.get(id("Water"))!.id;
  const ex = (pin_id: number, qty: number) => ({
    pin_id, type_id: g(1063), latitude: 0, longitude: 0, install_time: iso(now - 2 * H), expiry_time: iso(now + 22 * H),
    extractor_details: { cycle_time: 900, head_radius: 0.01, product_type_id: id("Aqueous Liquids"), qty_per_cycle: qty, heads: [] },
  });
  const fac = (pin_id: number) => ({ pin_id, type_id: g(1028), latitude: 0, longitude: 0, schematic_id: water, last_cycle_start: iso(now) });
  const r = (route_id: number, s: number, d: number, type: string, quantity: number) =>
    ({ route_id, source_pin_id: s, destination_pin_id: d, content_type_id: id(type), quantity });
  // A small extractor feeds factory 2 directly; factory 3 has no input route; neither factory's Water goes anywhere.
  const a = analyzeColony(sde!, pi, {
    pins: [ex(1, 500), fac(2), fac(3)],
    routes: [r(1, 1, 2, "Aqueous Liquids", 500)],
  }, now);
  assert.deepEqual(a.unroutedInputs, [{ product: id("Water"), input: id("Aqueous Liquids"), factories: 1 }]);
  assert.equal(a.routeShortfalls.length, 1);
  const s = a.routeShortfalls[0];
  assert.equal(s.need, 6_000);
  assert.ok(s.have > 0 && s.have < 3_000, `about 2,000/h reaches the factory (${s.have})`);
  assert.deepEqual(a.unroutedOutputs, [{ type: id("Water"), from: "factory", pins: 2 }]);
  // Planet-wide the extractor makes ~2,000/h but only the routed share counts: factory 3 makes nothing.
  assert.ok(a.made.get(id("Water"))! < 40 * (s.have / s.need) + 1e-6);
  // No routes in the payload at all (old data): fall back to the planet-wide balance.
  const loose = analyzeColony(sde!, pi, { pins: [ex(1, 500), fac(2), fac(3)] }, now);
  assert.deepEqual(loose.unroutedInputs, []);
});

// ---------------------------------------------------------------------------------------------------------------
// The planets tool

withSde("planets covers every character, ranks what needs attention and reports missing scopes", async () => {
  const now = Date.now();
  const systemId = sde!.systemIdByName("J105443")!;
  const planet = sde!.planetsInSystem(systemId)[0];
  const MAIN = character(90300001, "Colony Main");
  const NOSCOPE = character(90300002, "Colony Alt", STANDARD_SCOPES.filter((s) => s !== "esi-planets.manage_planets.v1"));
  const ctx = testCtx({
    characters: [MAIN, NOSCOPE],
    esi: {
      [`/characters/${MAIN.id}/planets`]: [
        { planet_id: planet.id, planet_type: "barren", solar_system_id: systemId, upgrade_level: 5, num_pins: 4, last_update: iso(now - 2 * H) },
      ],
      [`/characters/${MAIN.id}/planets/${planet.id}`]: layout(now),
    },
  });
  const r = await callTool(ctx, "planets", {});
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.colonies, 1);
  assert.deepEqual(r.json.characters_with_colonies, ["Colony Main (1)"]);
  assert.match(r.json.attention[0], new RegExp(`^Colony Main: ${planet.name}: Aqueous Liquids extractor ends in 2h`), r.json.attention.join("\n"));
  assert.match(r.json.attention[0], /\+\d+ more below/, "other issues are counted, not repeated");
  const p = r.json.planets[0];
  assert.equal(p.system, "J105443");
  assert.match(p.data_age, /^2h/);
  assert.equal(p.extractors[0].heads, 8);
  assert.match(p.extractors[0].status, /left$/);
  assert.ok(p.factories.includes("Coolant (P2) x1 (1 idle)"), p.factories.join(", "));
  assert.ok(p.shortfalls.some((s: string) => /^Electrolytes: factories need 40\/h, the planet makes 0\/h/.test(s)), p.shortfalls.join("\n"));
  assert.ok(p.routing.includes("1 factory making Coolant has no route bringing Electrolytes, so it can't run"), p.routing.join(" | "));
  assert.match(p.storage, /^1,900 \/ 10,000 m³/);
  assert.match(r.json.unavailable["Colony Alt"], /esi-planets\.manage_planets\.v1/);
});

withSde("planets filters by system and by character", async () => {
  const now = Date.now();
  const systemId = sde!.systemIdByName("J105443")!;
  const planet = sde!.planetsInSystem(systemId)[0];
  const MAIN = character(90300011, "Filter Main");
  const ctx = testCtx({
    characters: [MAIN],
    esi: {
      [`/characters/${MAIN.id}/planets`]: [
        { planet_id: planet.id, planet_type: "barren", solar_system_id: systemId, upgrade_level: 5, num_pins: 4, last_update: iso(now) },
      ],
      [`/characters/${MAIN.id}/planets/${planet.id}`]: layout(now),
    },
  });
  const other = await callTool(ctx, "planets", { character: "Filter Main", system: "Jita" });
  assert.equal(other.isError, false, other.text);
  assert.equal(other.json.colonies, 0);
  assert.deepEqual(other.json.attention, ["nothing needs attention"]);
  const here = await callTool(ctx, "planets", { character: "Filter Main", system: "J105443", include_storage: true });
  assert.ok(here.json.planets[0].contents.includes("Water x10,000"));
});
