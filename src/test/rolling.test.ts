import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { Sde } from "../sde/db.js";
import { parseEft, type Fit } from "../fit/model.js";
import { rollingAnalysis } from "../fit/rolling.js";

// Fake SDE: a 1b kg hull, capital and large prop modules, a plate and a Higgs Anchor.
const TYPES: Record<number, { name: string; group_id: number; mass?: number; attrs: Record<number, number> }> = {
  1: { name: "Hull", group_id: 547, mass: 1_000_000_000, attrs: {} },
  10: { name: "Big MWD", group_id: 46, attrs: { 796: 500_000_000, 554: 500 } },
  11: { name: "Big AB", group_id: 46, attrs: { 796: 500_000_000 } },
  12: { name: "Small MWD", group_id: 46, attrs: { 796: 50_000_000, 554: 500 } },
  20: { name: "Plate", group_id: 329, attrs: { 796: 100_000_000 } },
  30: { name: "Higgs", group_id: 1308, attrs: { 1131: 100 } },
};
const fakeSde = {
  type: (id: number) => (TYPES[id] ? { id, ...TYPES[id] } : null),
  typeName: (id: number) => TYPES[id]?.name ?? `#${id}`,
  attr: (id: number, a: number) => TYPES[id]?.attrs[a] ?? null,
} as unknown as Sde;

function fit(name: string, med: number[], low: number[] = [], rig: number[] = []): Fit {
  const mods = (ids: number[]) => ids.map((type_id) => ({ type_id }));
  return {
    name, ship_type_id: 1,
    slots: { high: [], med: mods(med), low: mods(low), rig: mods(rig), subsystem: [], service: [] },
    drones: [], fighters: [], cargo: [], implants: [],
  };
}

test("ordinary fits with one prop module get no rolling section", () => {
  assert.equal(rollingAnalysis(fakeSde, fit("PvP", [10])), undefined);
});

test("jump mass: plates always count, prop modules only while running", () => {
  const r = rollingAnalysis(fakeSde, fit("Roller", [10, 11], [20]))!;
  assert.deepEqual(r.jump_mass.map((j) => [j.mode, j.module, j.mass_kg]), [
    ["cold (no prop running)", undefined, 1_100_000_000],
    ["hot (AB)", "Big AB", 1_600_000_000],
    ["hot (MWD)", "Big MWD", 1_600_000_000],
  ]);
  assert.equal(r.advice, undefined, "big MWD plus matching AB needs no advice");
});

test("Higgs Anchor doubles everything and marks the fit as a roller", () => {
  const r = rollingAnalysis(fakeSde, fit("Anything", [10], [], [30]))!;
  assert.equal(r.higgs_anchor, "mass x2");
  assert.deepEqual(r.jump_mass.map((j) => j.mass_kg), [2_000_000_000, 3_000_000_000]);
});

test("advice: MWD without a matching AB, and small prop modules are low value", () => {
  const r = rollingAnalysis(fakeSde, fit("hole roller", [10, 12]))!;
  assert.equal(r.advice!.length, 2);
  assert.match(r.advice![0], /scrambler shuts microwarpdrives off/);
  assert.match(r.advice![1], /^Small MWD adds only \+50m kg \(10% of the big prop module\)/);
});

test("advice: AB alone gets told to add the big MWD", () => {
  const r = rollingAnalysis(fakeSde, fit("Rolling", [11]))!;
  assert.equal(r.advice!.length, 1);
  assert.match(r.advice![0], /No microwarpdrive of the biggest size/);
});

// With the real SDE (run the server or `eve-esi-mcp sde-update` once).
function openSde(): Sde | null {
  try {
    const pointer = join(loadConfig().home, "sde-current.json");
    if (!existsSync(pointer)) return null;
    const p = JSON.parse(readFileSync(pointer, "utf8"));
    return existsSync(p.path) ? new Sde(p.path) : null;
  } catch {
    return null;
  }
}
const sde = openSde();
const withSde = sde ? test : test.skip;

withSde("real rolling Archon: plates add mass, AB covers the scram case, 500MN MWD flagged", () => {
  const { fit } = parseEft(sde!, `[Archon, Archon Roller]
25000mm Steel Plates II
25000mm Crystalline Carbonide Restrained Plates

50000MN Microwarpdrive II
10000MN Afterburner II
Core X-Type 500MN Microwarpdrive
`);
  const r = rollingAnalysis(sde!, fit)!;
  const hull = sde!.type(fit.ship_type_id)!.mass!;
  assert.ok(hull > 1e9, "Archon hull mass comes from the type row");
  assert.equal(r.jump_mass[0].mass_kg, hull + 88_000_000 + 68_000_000);
  assert.equal(r.jump_mass.find((j) => j.module === "50000MN Microwarpdrive II")!.mass_kg, hull + 156_000_000 + 500_000_000);
  assert.equal(r.advice!.length, 1);
  assert.match(r.advice![0], /^Core X-Type 500MN Microwarpdrive adds only/);
});
