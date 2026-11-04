import { test } from "node:test";
import assert from "node:assert/strict";
import { STANDARD_SCOPES } from "../auth/scopes.js";
import { piData } from "../pi.js";
import { analyzeColony, cycleOutput, extractorProgram, yieldAt100 } from "../pi-colony.js";
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

// ---------------------------------------------------------------------------------------------------------------
// Colony analysis from an ESI layout

function layout(now: number) {
  const pi = piData(sde!);
  const sch = (product: string) => pi.schematic.get(id(product))!.id;
  const g = (group: number) => sde!.typeIdsInGroups([group])[0];
  const heads = (n: number) => Array.from({ length: n }, (_, i) => ({ head_id: i, latitude: 0, longitude: 0 }));
  return {
    links: [], routes: [],
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
  assert.equal(a.capacityM3, 10_000);
  assert.ok(Math.abs(a.storedM3 - 1900) < 1);
  const y = yieldAt100(a.extractors[0], 50)!;
  assert.ok(Math.abs(y - a.extractors[0].program!.avgPerHour * (10 / 8) * 2) < 1e-6, "scaled to 10 heads and a reading of 100");
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
