import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { Sde, displaySecurity } from "../sde/db.js";
import { fitFromFlaggedItems, numericFlagToName, parseEft, toDna, toEft, toEsiItems } from "../fit/model.js";
import { parseItemList } from "../market.js";
import { spForLevel } from "../skills.js";
import { compact, duration, isk } from "../util.js";

test("skill point curve", () => {
  assert.equal(spForLevel(1, 1), 250);
  assert.equal(spForLevel(1, 5), 256000);
  assert.equal(spForLevel(3, 4), 135765);
});

test("killmail flags map to slot names", () => {
  assert.equal(numericFlagToName(11), "LoSlot0");
  assert.equal(numericFlagToName(26), "MedSlot7");
  assert.equal(numericFlagToName(27), "HiSlot0");
  assert.equal(numericFlagToName(92), "RigSlot0");
  assert.equal(numericFlagToName(125), "SubSystemSlot0");
  assert.equal(numericFlagToName(87), "DroneBay");
  assert.equal(numericFlagToName(5), "Cargo");
});

test("security display rounding", () => {
  assert.equal(displaySecurity(0.04), 0.1);
  assert.equal(displaySecurity(0.946), 0.9);
  assert.equal(displaySecurity(-0.39), -0.4);
});

test("formatting helpers", () => {
  assert.equal(isk(1_234_567_890), "1.23b ISK");
  assert.equal(duration(90 * 60_000), "1h 30m");
  assert.deepEqual(compact({ a: 1, b: null, c: [], d: { e: undefined, f: 2 } }), { a: 1, d: { f: 2 } });
});

// The tests below need the local SDE index (run the server or `eve-esi-mcp sde-update` once).
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

const RIFTER = `[Rifter, Test Fit]
Damage Control II
Gyrostabilizer II

5MN Microwarpdrive II
Warp Disruptor II

200mm AutoCannon II, Republic Fleet EMP S
200mm AutoCannon II, Republic Fleet EMP S

Small Projectile Burst Aerator I


Warrior II x2


Republic Fleet EMP S x500
`;

withSde("EFT parse resolves names and slots", () => {
  const { fit, warnings } = parseEft(sde!, RIFTER);
  assert.deepEqual(warnings, []);
  assert.equal(sde!.typeName(fit.ship_type_id), "Rifter");
  assert.equal(fit.slots.low.length, 2);
  assert.equal(fit.slots.high.length, 2);
  assert.equal(sde!.typeName(fit.slots.high[0]!.charge_type_id!), "Republic Fleet EMP S");
  assert.deepEqual(fit.drones.map((d) => [sde!.typeName(d.type_id), d.quantity]), [["Warrior II", 2]]);
  assert.deepEqual(fit.cargo.map((d) => [sde!.typeName(d.type_id), d.quantity]), [["Republic Fleet EMP S", 500]]);
});

withSde("EFT survives a round trip through ESI fitting items", () => {
  const { fit } = parseEft(sde!, RIFTER);
  const items = toEsiItems(fit);
  assert.ok(items.some((i) => i.flag === "HiSlot1"));
  const back = fitFromFlaggedItems(sde!, fit.name, fit.ship_type_id, items);
  const eft = toEft(sde!, back);
  assert.match(eft, /^\[Rifter, Test Fit\]/);
  assert.match(eft, /\[Empty Low slot\]/);
  assert.match(eft, /Warrior II x2/);
  assert.match(toDna(back), /^587:/);
});

withSde("item lists parse in common formats", () => {
  const lines = parseItemList(sde!, "Tritanium\t10,000\tMineral\nPyerite x5000\n12 Hammerhead II\nPLEX");
  assert.deepEqual(lines.map((l) => [sde!.typeName(l.type_id!), l.quantity]), [
    ["Tritanium", 10000], ["Pyerite", 5000], ["Hammerhead II", 12], ["PLEX", 1],
  ]);
});

withSde("search understands shorthand", () => {
  assert.equal(sde!.typeName(sde!.searchTypes("dc ii")[0].id), "Damage Control II");
  assert.equal(sde!.typeName(sde!.searchTypes("gila")[0].id), "Gila");
});
