import { test } from "node:test";
import assert from "node:assert/strict";
import { sde, withSde } from "./harness.js";
import { displaySecurity } from "../sde/db.js";
import { describeEffectModifiers, effectName, massText, wormholeClassName, wormholeCode } from "../sde/wormholes.js";
import { WORMHOLE_STATICS } from "../sde/wormhole-statics.js";
import { fitFromFlaggedItems, numericFlagToName, parseEft, toDna, toEft, toEsiItems } from "../fit/model.js";
import { parseItemList } from "../market.js";
import { spForLevel } from "../skills.js";
import { currentLocation } from "../tools/character.js";
import { compact, duration, isk } from "../util.js";
import { applyPendingWrites } from "../tools/fittings.js";

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

test("fittings written by this process are overlaid on ESI's cached list", () => {
  const fit = (id: number) => ({ fitting_id: id, name: `Fit ${id}`, description: "", ship_type_id: 587, items: [] });
  const pending = { saved: [fit(3)], deleted: new Set([1]), until: 1000 };
  assert.deepEqual(applyPendingWrites([fit(1), fit(2)], pending, 500).map((f) => f.fitting_id), [2, 3]);
  assert.deepEqual(applyPendingWrites([fit(2), fit(3)], pending, 500).map((f) => f.fitting_id), [2, 3]);
  assert.deepEqual(applyPendingWrites([fit(1), fit(2)], pending, 2000).map((f) => f.fitting_id), [1, 2]);
});

test("wormhole helpers", () => {
  assert.equal(wormholeCode("h296"), "H296");
  assert.equal(wormholeCode("Wormhole K162"), "K162");
  assert.equal(wormholeCode("D845 - HS"), "D845");
  assert.equal(wormholeCode("J163701"), null);
  assert.equal(wormholeClassName(5), "C5");
  assert.equal(wormholeClassName(7), "highsec");
  assert.equal(wormholeClassName(12), "Thera");
  assert.equal(effectName("Class 6 Wolf Rayet Effects"), "Wolf-Rayet");
  assert.equal(massText(2_000_000_000), "2b kg");
  assert.equal(massText(375_000_000), "375m kg");
  assert.deepEqual(
    describeEffectModifiers([
      { name: "shieldCapacityMultiplier", display_name: "Shield Hitpoint Bonus", value: 1.86 },
      { name: "rechargeRateMultiplier", display_name: null, value: 0.57 },
      { name: "armorEmDamageResistanceBonus", display_name: null, value: 43 },
      { name: "armorKineticDamageResistanceBonus", display_name: null, value: 43 },
    ]),
    ["Shield HP: +86%", "Capacitor recharge time: -43%", "Armor damage taken (all damage types): +43%"],
  );
  assert.equal(WORMHOLE_STATICS[31002012], "H296");
});

// The tests below need the local SDE index (run the server or `eve-esi-mcp sde-update` once).

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

// Skips on an index built before wormhole columns existed (the server rebuilds it on start).
const withWormholes = sde && sde.system(31002012)?.wormhole_class_id !== undefined ? test : test.skip;

withWormholes("wormhole systems show class, effect and statics", () => {
  const home = sde!.systemIdByName("J163701")!;
  assert.equal(sde!.systemSummary(home)!.wormhole_class, "C5");
  const wh = sde!.wormholeSystem(home)!;
  assert.equal(wh.effect, "none");
  assert.equal(wh.shattered, undefined);
  assert.deepEqual(wh.statics, ["H296 → C5, 2b kg per jump, 3.3b kg total, 24h"]);
  const thera = sde!.systemSummary(sde!.systemIdByName("Thera")!)!;
  assert.equal(thera.wormhole_class, "Thera");
  const pulsar = sde!.db.prepare("SELECT s.id FROM systems s JOIN types t ON t.id = s.effect_beacon_id WHERE t.name = 'Class 5 Pulsar Effects' LIMIT 1").get() as any;
  const fx = sde!.wormholeSystem(pulsar.id)!.effect as { name: string; modifiers: string[] };
  assert.equal(fx.name, "Pulsar");
  assert.ok(fx.modifiers.includes("Shield HP: +86%"));
  assert.ok(fx.modifiers.includes("Armor damage taken (all damage types): +43%"));
  assert.equal(sde!.wormholeSystem(sde!.systemIdByName("Jita")!), null);
  assert.equal(sde!.systemSummary(sde!.systemIdByName("Jita")!)!.wormhole_class, undefined);
});

withWormholes("wormhole types resolve by code", () => {
  const d845 = sde!.wormholeType("d845")!;
  assert.equal(d845.leads_to, "highsec");
  assert.equal(d845.max_jump_mass_kg, 375_000_000);
  assert.equal(d845.total_mass_kg, 5_000_000_000);
  assert.equal(d845.lifetime_hours, 24);
  assert.ok(d845.static_in?.includes("C3"));
  assert.equal(sde!.wormholeType("K162")!.leads_to, "anywhere");
  assert.equal(sde!.wormholeType("C729")!.leads_to, "known space (varies)");
  assert.equal(sde!.wormholeType("A009")!.lifetime_hours, 4.5);
  assert.equal(sde!.wormholeType("Z999"), null);
});

withWormholes("character location in J-space includes wormhole details", async () => {
  const ctx = {
    esi: { get: async () => ({ solar_system_id: 31002012 }) },
    sde: async () => sde!,
    resolver: { location: async () => null },
  } as any;
  const loc = await currentLocation(ctx, { id: 1, name: "Test" } as any);
  assert.equal(loc.system.name, "J163701");
  assert.equal(loc.system.wormhole_class, "C5");
  assert.deepEqual(loc.system.wormhole?.statics, ["H296 → C5, 2b kg per jump, 3.3b kg total, 24h"]);
  assert.equal(loc.docked_at, null);
});
