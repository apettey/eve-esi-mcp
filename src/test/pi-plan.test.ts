import assert from "node:assert/strict";
import { piData } from "../pi.js";
import { pinCosts } from "../pi-layout.js";
import { planMarkdown, routine, type PlanColony, type SavedPlan } from "../pi-plan.js";
import { sde, withSde } from "./harness.js";

const id = (name: string) => sde!.typeIdByName(name)!;

/** A small hand-made plan: Miner A and Maker B extract, Maker B runs an Enriched Uranium factory on their output. */
function plan(): SavedPlan {
  const systemId = sde!.systemIdByName("J105443")!;
  const planets = sde!.planetsInSystem(systemId);
  const pl = (i: number, type: string) => ({ id: planets[i].id, name: planets[i].name, type });
  const ext = (character: string, planet: ReturnType<typeof pl>, outputs: Array<[string, number]>): PlanColony => ({
    character, planet, kind: "extraction", describe: "extract", iskPerHour: 100_000, capitalPerHour: 0, programHours: 24,
    layout: { ccLevel: 5, extractors: [], factories: [], storage: 0, launchpads: 1 },
    outputs: outputs.map(([t, perHour]) => ({ type: id(t), perHour })),
  });
  return {
    version: 1, name: "Test plan", savedAt: "2026-11-04T00:00:00.000Z", system: { id: systemId, name: "J105443" }, market: "Jita",
    restockDays: 2,
    colonies: [
      // Listed factory character first: the routine still runs the extraction-only character first.
      {
        character: "Maker B", planet: pl(0, "Barren"), kind: "factory", describe: "factory", iskPerHour: 150_000, capitalPerHour: 0,
        programHours: 24, product: id("Enriched Uranium"),
        layout: { ccLevel: 5, extractors: [], factories: [{ product: id("Enriched Uranium"), count: 2 }], storage: 1, launchpads: 1 },
        outputs: [{ type: id("Enriched Uranium"), perHour: 10 }],
        bought: [], local: [{ type: id("Precious Metals"), perHour: 80 }, { type: id("Toxic Metals"), perHour: 80 }],
      },
      ext("Maker B", pl(2, "Barren"), [["Precious Metals", 30]]),
      ext("Miner A", pl(1, "Lava"), [["Toxic Metals", 100]]),
      ext("Miner A", pl(3, "Barren"), [["Precious Metals", 120]]),
    ],
    exports: [], totals: { iskPerDay: 0, inputsPerDay: 0, haulInM3PerDay: 0, haulOutM3PerDay: 0 },
  };
}

withSde("the routine says, in order, what to collect on each planet and exactly where it goes", () => {
  const pi = piData(sde!);
  const p = plan();
  const r = routine(sde!, pi, p);
  assert.deepEqual(r.runs.map((x) => x.character), ["Miner A", "Maker B"], "extraction-only characters go first");
  const [a, b] = r.runs;
  assert.equal(a.every, "day");
  // Miner A: planets in orbit order, each with its split. Maker B's factory takes its own Precious Metals first.
  assert.equal(a.steps.length, 3);
  assert.match(a.steps[0], /^II \(Lava\): restart the extractor programs \(1-day, 15 min cycles, same heads\)\. Launch 2,400 Toxic Metals .* Where it goes: Toxic Metals: 1,920 for I \(Maker B\), 480 to the stockpile\.$/);
  assert.match(a.steps[1], /^IV \(Barren\): .*Launch 2,880 Precious Metals .* Where it goes: Precious Metals: 1,200 for I \(Maker B\), 1,680 to the stockpile\.$/);
  assert.match(a.steps[2], /^Dock and put everything in the shared hangar/);
  assert.match(b.steps[0], /^III \(Barren\): .*Where it goes: Precious Metals: 720 for I \(Maker B\)\.$/);
  // Every 2 days: 80/h of each input = 3,840, and it says which colony each part comes from.
  const factory = b.steps.find((s) => s.startsWith("Every 2 days"))!;
  assert.match(factory, /^Every 2 days, I \(Barren\) Enriched Uranium factories: take 3,840 Precious Metals \(from III \(Maker B\) 1,440, IV \(Miner A\) 2,400\), 3,840 Toxic Metals \(from II \(Miner A\) 3,840\) from the hangar, fly to the I customs office/);
  assert.match(factory, /Launch the 480 Enriched Uranium it made/);
  assert.ok(b.cargoM3.factoryVisit > b.cargoM3.everyVisit);
  assert.deepEqual(r.stockpile.map(([t, x]) => [sde!.typeName(t), Math.round(x)]).sort(),
    [["Enriched Uranium", 240], ["Precious Metals", 1680], ["Toxic Metals", 480]]);
  assert.deepEqual(r.short, []);
  assert.deepEqual(routine(sde!, pi, p), r, "the same every time");

  const book = planMarkdown(sde!, pi, pinCosts(sde!), p);
  assert.match(book, /## Every undock\n\nRun the characters in this order.*\n\n### Miner A: every day\n\nCargo: [\d,]+ m³\n\n1\. II \(Lava\)/);
  assert.match(book, /### Maker B: every day\n\nCargo: [\d,]+ m³, [\d,]+ m³ on factory days/);
});

withSde("the routine flags factory inputs the plan's colonies don't cover", () => {
  const p = plan();
  p.colonies = p.colonies.filter((c) => c.character !== "Miner A");
  const r = routine(sde!, piData(sde!), p);
  assert.deepEqual(r.short.map(([t, x]) => [sde!.typeName(t), Math.round(x)]), [["Precious Metals", 1200], ["Toxic Metals", 1920]]);
});
