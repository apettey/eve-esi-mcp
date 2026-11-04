import assert from "node:assert/strict";
import { piData } from "../pi.js";
import { TEMPLATE_SPACING, buildTemplate, pinDistanceKm, templateFileName, templateFromEsi } from "../pi-template.js";
import { sde, withSde } from "./harness.js";
import { checkTemplate } from "./pi-template-check.js";

const id = (name: string) => sde!.typeIdByName(name)!;

withSde("buildTemplate lays out a hub colony the client can import", () => {
  const pi = piData(sde!);
  const layout = {
    ccLevel: 5,
    extractors: [{ resource: id("Aqueous Liquids"), heads: 7, perHour: 12_000 }, { resource: id("Ionic Solutions"), heads: 7, perHour: 12_600 }],
    factories: [{ product: id("Coolant"), count: 2 }, { product: id("Water"), count: 2 }, { product: id("Electrolytes"), count: 2 }],
    storage: 1, launchpads: 1,
  };
  const { template: t, links } = buildTemplate(sde!, pi, { layout, planetType: "Gas", name: "J1 V - Coolant (Alt)", diameterKm: 10_000 });
  checkTemplate(t);
  assert.equal(t.CmdCtrLv, 5);
  assert.equal(t.Cmt, "J1 V - Coolant (Alt)");
  assert.equal(t.Diam, 10_000);
  assert.equal(sde!.typeName(t.Pln), "Planet (Gas)");
  // The launchpad first, then 6 factories, 2 extractors, 1 storage.
  assert.equal(t.P.length, 10);
  assert.equal(sde!.typeName(t.P[0].T), "Gas Launchpad");
  assert.deepEqual(t.P.filter((p) => /Basic/.test(sde!.typeName(p.T))).map((p) => sde!.typeName(p.S!)).sort(), ["Electrolytes", "Electrolytes", "Water", "Water"]);
  assert.equal(t.P.filter((p) => p.S === id("Coolant")).length, 2);
  const ecus = t.P.filter((p) => /Extractor Control Unit/.test(sde!.typeName(p.T)));
  assert.deepEqual(ecus.map((p) => [sde!.typeName(p.S!), p.H]), [["Aqueous Liquids", 7], ["Ionic Solutions", 7]]);
  assert.equal(t.P.filter((p) => /Storage/.test(sde!.typeName(p.T))).length, 1);
  // A tree of links: one per structure besides the launchpad, each one lattice step long.
  assert.equal(t.L.length, 9);
  for (const l of t.L) {
    const km = pinDistanceKm(t.P[l.S - 1], t.P[l.D - 1], 5_000);
    assert.ok(Math.abs(km - TEMPLATE_SPACING * 5_000) < 1.5, `${km} km`);
  }
  assert.equal(links.count, 9);
  assert.ok(Math.abs(links.totalKm - 9 * TEMPLATE_SPACING * 5_000) < 10, `${links.totalKm}`);
  // Routes: extractors to the launchpad; each factory gets every input from it and returns its output to it.
  const pad = 1;
  for (const [i, p] of t.P.entries()) {
    const me = i + 1;
    if (/Extractor/.test(sde!.typeName(p.T))) {
      const r = t.R.filter((x) => x.P[0] === me);
      assert.equal(r.length, 1);
      assert.equal(r[0].P.at(-1), pad);
      assert.equal(r[0].T, p.S);
      assert.equal(r[0].Q, Math.round(p.S === id("Aqueous Liquids") ? 12_000 / 4 : 12_600 / 4), "a 15-minute cycle's output");
    }
    if (p.S && pi.schematic.has(p.S) && pi.tier.get(p.S)! > 0) {
      const s = pi.schematic.get(p.S)!;
      for (const [input, q] of s.inputs) assert.ok(t.R.some((r) => r.P[0] === pad && r.P.at(-1) === me && r.T === input && r.Q === q), `${sde!.typeName(input)} to ${me}`);
      assert.ok(t.R.some((r) => r.P[0] === me && r.P.at(-1) === pad && r.T === p.S && r.Q === s.outputQty));
    }
  }
  assert.equal(templateFileName('J1 V - Coolant: "big"'), "J1 V - Coolant- -big-.json");
});

withSde("buildTemplate uses the planet's own structures and a High-Tech plant for P4", () => {
  const pi = piData(sde!);
  const { template: t } = buildTemplate(sde!, pi, {
    layout: { ccLevel: 4, extractors: [], factories: [{ product: id("Nano-Factory"), count: 1 }], storage: 1, launchpads: 2 },
    planetType: "Barren", name: "P4",
  });
  checkTemplate(t);
  assert.deepEqual(t.P.map((p) => sde!.typeName(p.T)), ["Barren Launchpad", "Barren High-Tech Production Plant", "Barren Storage Facility", "Barren Launchpad"]);
  assert.equal(t.R.filter((r) => r.T !== id("Nano-Factory")).length, pi.schematic.get(id("Nano-Factory"))!.inputs.length);
  assert.ok(t.Diam > 0, "a default diameter when the planet isn't known");
});

withSde("templateFromEsi copies a real colony: structures, links and routes with waypoints", () => {
  const pi = piData(sde!);
  const g = (name: string) => id(name);
  const esi = {
    pins: [
      { pin_id: 100, type_id: g("Barren Command Center"), latitude: 2.1, longitude: 0.6 },
      { pin_id: 101, type_id: g("Barren Launchpad"), latitude: 2.1058, longitude: 0.6437 },
      { pin_id: 102, type_id: g("Barren Advanced Industry Facility"), latitude: 2.1054, longitude: 0.6577, schematic_id: pi.schematic.get(id("Coolant"))!.id },
      { pin_id: 103, type_id: g("Barren Advanced Industry Facility"), latitude: 2.1047, longitude: 0.6716, factory_details: { schematic_id: pi.schematic.get(id("Coolant"))!.id } },
      {
        pin_id: 104, type_id: g("Barren Extractor Control Unit"), latitude: 2.09, longitude: 0.64,
        extractor_details: { product_type_id: id("Noble Metals"), heads: [{ head_id: 0 }, { head_id: 1 }, { head_id: 2 }], qty_per_cycle: 900, cycle_time: 900 },
      },
    ],
    links: [
      { source_pin_id: 102, destination_pin_id: 101, link_level: 0 },
      { source_pin_id: 103, destination_pin_id: 102, link_level: 1 },
      { source_pin_id: 104, destination_pin_id: 101, link_level: 0 },
      { source_pin_id: 100, destination_pin_id: 101, link_level: 0 }, // command center links aren't part of a template
    ],
    routes: [
      { content_type_id: id("Water"), source_pin_id: 101, destination_pin_id: 103, quantity: 40, waypoints: [102] },
      { content_type_id: id("Coolant"), source_pin_id: 103, destination_pin_id: 101, quantity: 5, waypoints: [102] },
      { content_type_id: id("Noble Metals"), source_pin_id: 104, destination_pin_id: 101, quantity: 900 },
    ],
  };
  const { template: t, links } = templateFromEsi(sde!, pi, esi, { planetType: "Barren", ccLevel: 5, name: "Copy", diameterKm: 6_000 });
  checkTemplate(t);
  assert.equal(t.P.length, 4, "no command center");
  assert.deepEqual(t.P.map((p) => p.S && sde!.typeName(p.S)), [null, "Coolant", "Coolant", "Noble Metals"]);
  assert.equal(t.P[3].H, 3);
  assert.deepEqual(t.P[0], { H: 0, La: 2.1058, Lo: 0.6437, S: null, T: g("Barren Launchpad") });
  assert.deepEqual(t.L, [{ D: 1, Lv: 0, S: 2 }, { D: 2, Lv: 1, S: 3 }, { D: 1, Lv: 0, S: 4 }]);
  assert.deepEqual(t.R.map((r) => r.P), [[1, 2, 3], [3, 2, 1], [4, 1]]);
  assert.ok(links.totalKm > 0);
});
