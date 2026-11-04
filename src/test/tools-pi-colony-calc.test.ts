import assert from "node:assert/strict";
import { piData } from "../pi.js";
import { CC_LEVELS, LINK_RESERVE, layoutCapacity, layoutCost, layoutFits, pinCosts, simulate, type Layout } from "../pi-layout.js";
import { callTool, character, sde, testCtx, withSde } from "./harness.js";

const JITA_44 = 60003760;
const id = (name: string) => sde!.typeIdByName(name)!;

// ---------------------------------------------------------------------------------------------------------------
// Shared layout model

withSde("layout cost adds up SDE structure costs and links", () => {
  const pi = piData(sde!);
  const costs = pinCosts(sde!);
  const l: Layout = {
    ccLevel: 5, storage: 1, launchpads: 1,
    extractors: [{ resource: id("Heavy Metals"), heads: 8, perHour: 20_000 }],
    factories: [{ product: id("Toxic Metals"), count: 3 }],
  };
  const c = layoutCost(costs, pi, l);
  const expectPg = costs.launchpad.pg + costs.storage.pg + costs.ecu.pg + 7 * costs.head.pg + 3 * costs.basic.pg;
  assert.equal(c.pg, expectPg);
  assert.deepEqual(layoutCapacity(l), { cpu: CC_LEVELS[5].cpu * (1 - LINK_RESERVE), pg: CC_LEVELS[5].pg * (1 - LINK_RESERVE) });
  const linked = layoutCost(costs, pi, { ...l, links: { count: 5, totalKm: 100 } });
  assert.equal(linked.pg, expectPg + 5 * 10 + 100 * 0.15, "links: 10 MW each plus 0.15 MW per km");
  assert.equal(layoutCapacity({ ...l, links: { count: 5, totalKm: 100 } }).pg, CC_LEVELS[5].pg, "no reserve when links are given");
  assert.equal(layoutFits(costs, pi, { ...l, ccLevel: 0 }), false);
});

withSde("simulate runs factories at the share their scarcest input allows", () => {
  const pi = piData(sde!);
  // 9,000 P0/h into 2 basics (12,000/h capacity): 75% busy, 60 P1/h. Coolant needs Electrolytes too: idle.
  const sim = simulate(pi, {
    ccLevel: 5, storage: 0, launchpads: 1,
    extractors: [{ resource: id("Aqueous Liquids"), heads: 10, perHour: 9_000 }],
    factories: [{ product: id("Water"), count: 2 }, { product: id("Coolant"), count: 1 }],
  });
  assert.equal(sim.utilisation.get(id("Water")), 0.75);
  assert.equal(sim.made.get(id("Water")), 60);
  assert.equal(sim.utilisation.get(id("Coolant")), 0);
  assert.equal(sim.leftover.get(id("Water")), 60, "unused P1 is exported");
  const bought = simulate(pi, {
    ccLevel: 5, storage: 0, launchpads: 1, extractors: [], buyMissing: true,
    factories: [{ product: id("Coolant"), count: 1 }],
  });
  assert.equal(bought.utilisation.get(id("Coolant")), 1);
  assert.equal(bought.bought.get(id("Electrolytes")), 40);
});

// ---------------------------------------------------------------------------------------------------------------
// The tool

function calcCtx(extra: Record<string, unknown> = {}, characters = [character(90400001, "Calc Main")]) {
  const pi = piData(sde!);
  const price = (t: number) => [5, 500, 12_000, 90_000, 1_600_000][pi.tier.get(t) ?? 0];
  return testCtx({
    characters,
    esi: {
      "/markets/10000002/orders": (req: any) => [
        { type_id: req.query.type_id, is_buy_order: false, price: price(req.query.type_id), volume_remain: 1_000_000, location_id: JITA_44 },
      ],
      ...extra,
    },
  });
}

withSde("pi_colony_calc says a layout doesn't fit and how to make it fit", async () => {
  const r = await callTool(calcCtx(), "pi_colony_calc", {
    planet_type: "ice",
    extractors: [{ resource: "Heavy Metals", reading: 100 }, { resource: "Aqueous Liquids", reading: 100 }],
    factories: [{ product: "Toxic Metals", count: 4 }, { product: "Water", count: 4 }],
  });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.fits, false);
  assert.match(r.json.powergrid, /\(1\d\d%\)$/);
  assert.match(r.json.suggestions[0], /^To fit: remove \d+ x /, r.json.suggestions[0]);
  assert.match(r.json.economics.isk_per_day, /ISK$/);
  assert.ok(r.json.per_day.unprocessed_p0.length > 0);
});

withSde("pi_colony_calc suggests the best addition that still fits", async () => {
  const r = await callTool(calcCtx(), "pi_colony_calc", {
    planet_type: "Lava",
    extractors: [{ resource: "Heavy Metals", heads: 8, p0_per_hour: 25_000 }, { resource: "Heavy Metals", heads: 8, p0_per_hour: 25_000 }],
    factories: [{ product: "Toxic Metals", count: 4 }],
    storage_facilities: 1,
    links: { count: 7, total_km: 200 }, // like the real colony; the default 6% reserve leaves no room for a 5th basic
  });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.fits, true);
  assert.deepEqual(r.json.factories, ["Toxic Metals (P1) x4: 100% busy"]);
  assert.match(r.json.suggestions[0], /^add 1 Basic Industry Facility \(Toxic Metals\): \+.* ISK\/day \(still fits\)$/);
});

withSde("pi_colony_calc rejects resources and products the planet can't have", async () => {
  const wrong = await callTool(calcCtx(), "pi_colony_calc", { planet_type: "Gas", extractors: [{ resource: "Heavy Metals", reading: 50 }] });
  assert.equal(wrong.isError, true);
  assert.match(wrong.text, /Gas planets have no Heavy Metals\. They have: /);
  const p4 = await callTool(calcCtx(), "pi_colony_calc", { planet_type: "Gas", factories: [{ product: "Nano-Factory", count: 1 }] });
  assert.match(p4.text, /High-Tech Production Plant, which only Barren and Temperate/);
  const noYield = await callTool(calcCtx(), "pi_colony_calc", { planet_type: "Lava", extractors: [{ resource: "Heavy Metals" }] });
  assert.match(noYield.text, /give a scan reading, qty_per_cycle or p0_per_hour/);
});

withSde("pi_colony_calc checks a real colony from ESI with real link lengths", async () => {
  const MAIN = character(90400011, "Calc Owner");
  const systemId = sde!.systemIdByName("J105443")!;
  const planet = sde!.planetsInSystem(systemId).find((p) => p.name.endsWith(" II"))!; // Lava
  const now = Date.now();
  const g = (group: number) => sde!.typeIdsInGroups([group])[0];
  const pi = piData(sde!);
  const ctx = calcCtx({
    [`/characters/${MAIN.id}/planets`]: [{ planet_id: planet.id, planet_type: "lava", solar_system_id: systemId, upgrade_level: 4, num_pins: 4, last_update: new Date(now).toISOString() }],
    [`/characters/${MAIN.id}/planets/${planet.id}`]: {
      routes: [],
      links: [{ source_pin_id: 1, destination_pin_id: 2, link_level: 0 }, { source_pin_id: 1, destination_pin_id: 3, link_level: 0 }],
      pins: [
        { pin_id: 1, type_id: g(1030), latitude: 1.0, longitude: 1.0 },
        {
          pin_id: 2, type_id: g(1063), latitude: 1.01, longitude: 1.0,
          install_time: new Date(now - 6 * 3600_000).toISOString(), expiry_time: new Date(now + 18 * 3600_000).toISOString(),
          extractor_details: { cycle_time: 900, head_radius: 0.01, product_type_id: id("Heavy Metals"), qty_per_cycle: 2_000, heads: [{ head_id: 0, latitude: 0, longitude: 0 }] },
        },
        { pin_id: 3, type_id: g(1028), latitude: 1.0, longitude: 1.01, schematic_id: pi.schematic.get(id("Toxic Metals"))!.id },
      ],
    },
  }, [MAIN]);
  const r = await callTool(ctx, "pi_colony_calc", { from_colony: { planet: planet.name } });
  assert.equal(r.isError, false, r.text);
  assert.match(r.json.source, new RegExp(`^Calc Owner's colony on ${planet.name}`));
  assert.equal(r.json.planet_type, "Lava");
  assert.equal(r.json.command_center_level, 4);
  const km = Number(/(\d[\d,]*) km/.exec(r.json.links)![1].replace(/,/g, ""));
  assert.ok(km > 0, r.json.links);
  assert.match(r.json.links, /^2 links/);
  assert.ok(r.json.structures.some((s: string) => /^Extractor 1: Heavy Metals, 1 heads, [\d,]+\/h$/.test(s)), r.json.structures.join("\n"));

  const none = await callTool(ctx, "pi_colony_calc", { from_colony: { planet: "Jita IV" } });
  assert.equal(none.isError, true);
  assert.match(none.text, /Calc Owner has no colony on "Jita IV"\. Colonies: /);
});
