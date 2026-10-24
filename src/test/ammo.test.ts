import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { CATEGORY, Sde } from "../sde/db.js";
import { chargeFits, loadCargoAmmo } from "../fit/ammo.js";
import { CONTRACT, FitStats, type FitEngine } from "../fit/evefit.js";
import { parseEft, toEft, type Fit } from "../fit/model.js";

// A tiny fake SDE: one small turret (charge group 83, size 1), its ammo in two sizes, and a launcher (no size).
const TYPES: Record<number, { name: string; group_id: number; category_id: number; hardpoint?: string; attrs: Record<number, number> }> = {
  1: { name: "Small Gun", group_id: 55, category_id: 7, hardpoint: "turret", attrs: { 604: 83, 128: 1 } },
  2: { name: "Light Launcher", group_id: 509, category_id: 7, hardpoint: "launcher", attrs: { 604: 384, 605: 394 } },
  3: { name: "Damage Control", group_id: 60, category_id: 7, attrs: {} },
  10: { name: "Ammo S", group_id: 83, category_id: CATEGORY.charge, attrs: { 128: 1 } },
  11: { name: "Ammo M", group_id: 83, category_id: CATEGORY.charge, attrs: { 128: 2 } },
  12: { name: "Faction Ammo S", group_id: 83, category_id: CATEGORY.charge, attrs: { 128: 1 } },
  20: { name: "Light Missile", group_id: 384, category_id: CATEGORY.charge, attrs: {} },
};
const fakeSde = {
  type: (id: number) => (TYPES[id] ? { id, ...TYPES[id], hardpoint: TYPES[id].hardpoint ?? null } : null),
  typeName: (id: number) => TYPES[id]?.name ?? `#${id}`,
  typeAttributes: (id: number) => new Map(Object.entries(TYPES[id]?.attrs ?? {}).map(([k, v]) => [Number(k), v])),
  attr: (id: number, a: number) => TYPES[id]?.attrs[a] ?? null,
} as unknown as Sde;

function fit(cargo: Fit["cargo"]): Fit {
  return {
    name: "T", ship_type_id: 587,
    slots: {
      high: [{ type_id: 1 }, { type_id: 1 }, { type_id: 2 }, { type_id: 1, charge_type_id: 10 }],
      med: [], low: [{ type_id: 3 }], rig: [], subsystem: [], service: [],
    },
    drones: [], fighters: [], cargo, implants: [],
  };
}

test("charge compatibility checks group and turret size", () => {
  assert.equal(chargeFits(fakeSde, 1, 10), true);
  assert.equal(chargeFits(fakeSde, 1, 11), false, "wrong size");
  assert.equal(chargeFits(fakeSde, 1, 20), false, "wrong group");
  assert.equal(chargeFits(fakeSde, 2, 20), true, "launchers have no size");
  assert.equal(chargeFits(fakeSde, 3, 10), false, "not a weapon");
});

test("empty weapons get the largest compatible cargo stack; loaded ones and the original fit are untouched", () => {
  const original = fit([{ type_id: 11, quantity: 9000 }, { type_id: 10, quantity: 200 }, { type_id: 12, quantity: 300 }, { type_id: 10, quantity: 200 }]);
  const before = structuredClone(original);
  const r = loadCargoAmmo(fakeSde, original);
  assert.deepEqual(r.fit.slots.high.map((m) => m?.charge_type_id), [10, 10, undefined, 10]);
  assert.deepEqual(r.assumed, ["Small Gun x2: Ammo S (from cargo)"]);
  assert.deepEqual(r.unloaded, ["no compatible ammo in cargo for Light Launcher x1"]);
  assert.deepEqual(original, before);
});

test("an explicit cargo list can stand in for the fit's own", () => {
  const r = loadCargoAmmo(fakeSde, fit([]), [{ type_id: 20, quantity: 100 }]);
  assert.deepEqual(r.assumed, ["Light Launcher x1: Light Missile (from cargo)"]);
  assert.deepEqual(r.unloaded, ["no compatible ammo in cargo for Small Gun x2"]);
});

test("assumed charges are reported in stats", async () => {
  const engine: FitEngine = { call: async () => ({ contract: CONTRACT, valid: true, issues: [], stats: { dps_total: 1 } }) };
  const s: any = await new FitStats(engine).compute({ eft: "[Rifter, T]", assumedCharges: ["a"], unloadedWeapons: ["b"] });
  assert.deepEqual([s.assumed_charges, s.unloaded_weapons], [["a"], ["b"]]);
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

withSde("real charge groups and sizes match", () => {
  const id = (name: string) => sde!.searchTypes(name)[0].id;
  assert.equal(chargeFits(sde!, id("200mm AutoCannon II"), id("Republic Fleet EMP S")), true);
  assert.equal(chargeFits(sde!, id("200mm AutoCannon II"), id("Republic Fleet EMP M")), false);
  assert.equal(chargeFits(sde!, id("75mm Gatling Rail I"), id("Antimatter Charge S")), true);
  assert.equal(chargeFits(sde!, id("Light Missile Launcher II"), id("Scourge Light Missile")), true);
  assert.equal(chargeFits(sde!, id("Light Missile Launcher II"), id("Antimatter Charge S")), false);
});

withSde("the EFT sent to eve-fit has the cargo ammo loaded, the displayed EFT does not", async () => {
  const { fit } = parseEft(sde!, `[Rifter, Cargo Ammo]
Gyrostabilizer II

200mm AutoCannon II
200mm AutoCannon II

Republic Fleet EMP M x1000
Republic Fleet EMP S x500
EMP S x100
`);
  const sent: string[] = [];
  const engine: FitEngine = {
    call: async (_tool, args) => { sent.push(String(args.eft)); return { contract: CONTRACT, valid: true, issues: [], stats: {} }; },
  };
  const ammo = loadCargoAmmo(sde!, fit);
  const s: any = await new FitStats(engine).compute({ eft: toEft(sde!, ammo.fit), assumedCharges: ammo.assumed });
  assert.equal((sent[0].match(/^200mm AutoCannon II, Republic Fleet EMP S$/gm) ?? []).length, 2);
  assert.deepEqual(s.assumed_charges, ["200mm AutoCannon II x2: Republic Fleet EMP S (from cargo)"]);
  assert.doesNotMatch(toEft(sde!, fit), /AutoCannon II, /);
});
