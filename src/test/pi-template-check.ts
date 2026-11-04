import assert from "node:assert/strict";
import { PI_ATTR } from "../pi.js";
import type { PiTemplate } from "../pi-template.js";
import { sde } from "./harness.js";

/** Structural checks every template must pass for the client to build it. */
export function checkTemplate(t: PiTemplate) {
  const n = t.P.length;
  const linked = new Set(t.L.map((l) => `${Math.min(l.S, l.D)}-${Math.max(l.S, l.D)}`));
  for (const l of t.L) assert.ok(l.S >= 1 && l.S <= n && l.D >= 1 && l.D <= n && l.S !== l.D, JSON.stringify(l));
  for (const r of t.R) {
    assert.ok(r.P.length >= 2 && r.Q > 0, JSON.stringify(r));
    for (let i = 1; i < r.P.length; i++) {
      assert.ok(linked.has(`${Math.min(r.P[i - 1], r.P[i])}-${Math.max(r.P[i - 1], r.P[i])}`), `route ${JSON.stringify(r)} follows links`);
    }
  }
  for (const p of t.P) {
    assert.equal(sde!.attr(p.T, PI_ATTR.planetRestriction), t.Pln, `${sde!.typeName(p.T)} belongs on planet type ${t.Pln}`);
    assert.ok(p.La > 0 && p.La < Math.PI && p.Lo >= 0 && p.Lo < 2 * Math.PI, JSON.stringify(p));
  }
}
