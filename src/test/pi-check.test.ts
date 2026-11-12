import assert from "node:assert/strict";
import { piData } from "../pi.js";
import { checkColony, checkPlan } from "../pi-check.js";
import type { PlanColony, SavedPlan } from "../pi-plan.js";
import { planetPins } from "../pi-template.js";
import { sde, withSde } from "./harness.js";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const id = (name: string) => sde!.typeIdByName(name)!;
const iso = (ms: number) => new Date(ms).toISOString();

function fixture() {
  const pi = piData(sde!);
  const pins = planetPins(sde!, pi).get("Barren")!;
  const systemId = sde!.systemIdByName("J105443")!;
  const planet = sde!.planetsInSystem(systemId)[0];
  const noble = id("Noble Metals");
  const precious = id("Precious Metals");
  const uranium = id("Enriched Uranium");
  const extraction: PlanColony = {
    character: "Miner A", planet: { id: planet.id, name: planet.name, type: "Barren" }, kind: "extraction", describe: "", iskPerHour: 1,
    capitalPerHour: 0, programHours: 24, outputs: [],
    layout: { ccLevel: 5, extractors: [{ resource: noble, heads: 8, perHour: 1 }, { resource: noble, heads: 8, perHour: 1 }], factories: [{ product: precious, count: 2 }], storage: 0, launchpads: 1 },
  };
  const factory: PlanColony = {
    ...extraction, character: "Maker B", kind: "factory", product: uranium,
    layout: { ccLevel: 5, extractors: [], factories: [{ product: uranium, count: 2 }], storage: 1, launchpads: 1 },
  };
  const plan: SavedPlan = {
    version: 1, name: "Test", savedAt: iso(NOW), system: { id: systemId, name: "J105443" }, market: "Jita", restockDays: 2,
    colonies: [extraction, factory], exports: [], totals: { iskPerDay: 0, inputsPerDay: 0, haulInM3PerDay: 0, haulOutM3PerDay: 0 },
  };
  const sid = (product: number) => pi.schematic.get(product)!.id;
  const heads = (n: number) => Array.from({ length: n }, (_, i) => ({ head_id: i, latitude: 1.5, longitude: 1.5 }));
  const ecu = (pin: number, n: number, expiry = NOW + 20 * 3_600_000) => ({
    pin_id: pin, type_id: pins.ecu, latitude: 1.5, longitude: 1.5, install_time: iso(expiry - 24 * 3_600_000), expiry_time: iso(expiry),
    extractor_details: { cycle_time: 900, heads: heads(n), product_type_id: noble, qty_per_cycle: 3000 },
  });
  /** The extraction colony as built: two extractors (8 and 7 heads), two Precious Metals factories, all routed. */
  const extractionLayout = (opts: { routeOutput?: boolean; expiry?: number; heads?: [number, number] } = {}) => ({
    links: [],
    pins: [
      { pin_id: 1, type_id: pins.launchpad, latitude: 1.5, longitude: 1.5 },
      { pin_id: 2, type_id: pins.basic, schematic_id: sid(precious), last_cycle_start: iso(NOW - 600_000) },
      { pin_id: 3, type_id: pins.basic, schematic_id: sid(precious), last_cycle_start: iso(NOW - 600_000) },
      ecu(4, opts.heads?.[0] ?? 8), ecu(5, opts.heads?.[1] ?? 7, opts.expiry),
    ],
    routes: [
      { source_pin_id: 4, destination_pin_id: 1, content_type_id: noble, quantity: 3000 },
      { source_pin_id: 5, destination_pin_id: 1, content_type_id: noble, quantity: 3000 },
      { source_pin_id: 1, destination_pin_id: 2, content_type_id: noble, quantity: 3000 },
      { source_pin_id: 1, destination_pin_id: 3, content_type_id: noble, quantity: 3000 },
      { source_pin_id: 2, destination_pin_id: 1, content_type_id: precious, quantity: 20 },
      ...(opts.routeOutput === false ? [] : [{ source_pin_id: 3, destination_pin_id: 1, content_type_id: precious, quantity: 20 }]),
    ],
  });
  const factoryLayout = (stock: number) => {
    const inputs = pi.schematic.get(uranium)!.inputs.map(([t]) => t);
    return {
      links: [],
      pins: [
        { pin_id: 1, type_id: pins.launchpad, contents: inputs.map((t) => ({ type_id: t, amount: stock })) },
        { pin_id: 2, type_id: pins.advanced, schematic_id: sid(uranium), last_cycle_start: iso(NOW - 600_000) },
        { pin_id: 3, type_id: pins.advanced, schematic_id: sid(uranium), last_cycle_start: iso(NOW - 600_000) },
      ],
      routes: [2, 3].flatMap((f) => [
        ...inputs.map((t) => ({ source_pin_id: 1, destination_pin_id: f, content_type_id: t, quantity: 40 })),
        { source_pin_id: f, destination_pin_id: 1, content_type_id: uranium, quantity: 5 },
      ]),
    };
  };
  return { pi, plan, extraction, factory, extractionLayout, factoryLayout, planet };
}

withSde("the plan check says per colony what differs from the plan", () => {
  const f = fixture();
  const ok = checkColony(sde!, f.pi, f.plan, f.extraction, f.extractionLayout(), 5, NOW);
  assert.deepEqual(ok.issues, ["Noble Metals 15 of 16 heads"], "heads are compared per resource");
  assert.equal(ok.line, "I (Barren): Noble Metals 15 of 16 heads");

  const bad = checkColony(sde!, f.pi, f.plan, f.extraction, f.extractionLayout({ routeOutput: false, expiry: NOW - 3_600_000 }), 4, NOW);
  assert.deepEqual(bad.issues, [
    "command center level 4, plan 5",
    "Noble Metals 15 of 16 heads",
    "Noble Metals program ended 1h ago",
    "Precious Metals from 1 factory isn't routed anywhere",
  ]);
  assert.deepEqual(checkColony(sde!, f.pi, f.plan, f.extraction, null, null, NOW).issues, ["not built yet"]);
  // More heads than planned are only a problem when they cost planned factories.
  const extra = checkColony(sde!, f.pi, f.plan, f.extraction, f.extractionLayout({ heads: [10, 8] }), 5, NOW);
  assert.deepEqual(extra.issues, [], "every planned factory is there: the extra head is free output");
  const crowded = f.extractionLayout({ heads: [10, 8] });
  crowded.pins = crowded.pins.filter((p: any) => p.pin_id !== 3);
  crowded.routes = crowded.routes.filter((r: any) => r.source_pin_id !== 3 && r.destination_pin_id !== 3);
  assert.deepEqual(checkColony(sde!, f.pi, f.plan, f.extraction, crowded, 5, NOW).issues,
    ["Noble Metals 18 heads, plan 16: remove 2 so the factories fit", "1 of 2 Precious Metals factories"]);

  // Factory colonies: less than a day of inputs on hand says what to bring for the restock period.
  const empty = checkColony(sde!, f.pi, f.plan, f.factory, f.factoryLayout(0), 5, NOW);
  assert.match(empty.issues[0], /^inputs for under a day \(on hand: \w[\w ]+ 0 \(none\), \w[\w ]+ 0 \(none\)\): bring \w[\w ]+ 3,840 \+ \w[\w ]+ 3,840 \(2 days\)$/);
  const stocked = checkColony(sde!, f.pi, f.plan, f.factory, f.factoryLayout(4000), 5, NOW);
  assert.equal(stocked.ok, true, stocked.line);
  assert.match(stocked.line, /^I \(Barren\): ok \(Enriched Uranium ×2; on hand: .* 4,000 \(2\.1 days\)/);
});

withSde("the plan check lists unplanned colonies and characters it couldn't read", () => {
  const f = fixture();
  const other = sde!.planetsInSystem(f.plan.system.id)[1];
  const checks = checkPlan(sde!, f.pi, f.plan, new Map<string, any>([
    ["Miner A", {
      planets: [
        { planet_id: f.planet.id, planet_type: "barren", solar_system_id: f.plan.system.id, upgrade_level: 5, last_update: iso(NOW - 7_200_000) },
        { planet_id: other.id, planet_type: "lava", solar_system_id: f.plan.system.id, upgrade_level: 1 },
      ],
      layouts: new Map([[f.planet.id, f.extractionLayout()]]),
    }],
    ["Maker B", new Error("token expired")],
  ]), NOW);
  assert.equal(checks[0].built, 1);
  assert.equal(checks[0].ok, false);
  assert.deepEqual(checks[0].extra, [`${other.name.split(" ").pop()} (lava)`]);
  assert.equal(checks[0].oldestUpdateMs, NOW - 7_200_000);
  assert.equal(checks[1].unavailable, "token expired");
});
