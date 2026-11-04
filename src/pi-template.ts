import type { Sde } from "./sde/db.js";
import { PI_ATTR, PI_GROUP, type PiData } from "./pi.js";
import { programCycleSeconds } from "./pi-colony.js";
import type { Layout } from "./pi-layout.js";

/**
 * EVE client colony templates (Planetary Industry view > Save as template / Open template > Import & Export). The client
 * reads them from the clipboard or from .json files in Documents\EVE\PlanetaryInteractionTemplates. The format isn't
 * documented by CCP; this follows templates saved by the client (github.com/MattFalahe/EVE-PI-Templates):
 *
 *   CmdCtrLv  command center level        Cmt  name                        Pln  planet type id
 *   Diam      planet diameter in km       P    structures, the command center not included:
 *             T type, La/Lo position in radians (same convention as ESI pin latitude/longitude), S what it makes (a
 *             factory's product or an extractor's P0, null otherwise), H extractor heads
 *   L         links {S, D: 1-based indexes into P, Lv: link level}
 *   R         routes {P: path as 1-based indexes into P, Q: quantity per cycle, T: commodity}
 *
 * Templates don't hold extractor head positions or programs: those are placed and started in game.
 * See docs/PLANETARY_INTERACTION.md section 5.2f.
 */

export interface PiTemplate {
  CmdCtrLv: number;
  Cmt: string;
  Diam: number;
  L: Array<{ D: number; Lv: number; S: number }>;
  P: Array<{ H: number; La: number; Lo: number; S: number | null; T: number }>;
  Pln: number;
  R: Array<{ P: number[]; Q: number; T: number }>;
}

export interface TemplateResult {
  template: PiTemplate;
  /** Links and their total length on this planet (0 km when the diameter is unknown). */
  links: { count: number; totalKm: number };
}

/** Spacing between neighbouring structures, in radians: what client-saved hub templates use (~0.0122). */
export const TEMPLATE_SPACING = 0.0122;
/** Diameter written when the planet isn't known. */
export const DEFAULT_DIAMETER_KM = 6000;

interface Pins { launchpad: number; storage: number; ecu: number; basic: number; advanced: number; highTech?: number }
const pinCache = new WeakMap<Sde, Map<string, Pins>>();

/** Structure type ids per planet type ("Barren" -> its launchpad, storage, ...). */
export function planetPins(sde: Sde, pi: PiData): Map<string, Pins> {
  const hit = pinCache.get(sde);
  if (hit) return hit;
  const out = new Map<string, Partial<Pins>>();
  const put = (id: number, key: keyof Pins) => {
    const pt = sde.attr(id, PI_ATTR.planetRestriction);
    const name = pt ? pi.planetType.get(pt) : undefined;
    if (!name) return;
    out.set(name, { ...out.get(name), [key]: id });
  };
  for (const id of sde.typeIdsInGroups([1030])) put(id, "launchpad");
  for (const id of sde.typeIdsInGroups([1029])) put(id, "storage");
  for (const id of sde.typeIdsInGroups([1063])) put(id, "ecu");
  for (const id of sde.typeIdsInGroups([PI_GROUP.processor])) {
    const n = sde.typeName(id);
    put(id, /Basic/.test(n) ? "basic" : /Advanced/.test(n) ? "advanced" : "highTech");
  }
  const done = new Map([...out].filter(([, p]) => p.launchpad && p.storage && p.ecu && p.basic && p.advanced) as Array<[string, Pins]>);
  pinCache.set(sde, done);
  return done;
}

export function planetTypeId(pi: PiData, name: string): number {
  for (const [id, n] of pi.planetType) if (n === name) return id;
  throw new Error(`unknown planet type ${name}`);
}

/** Hex lattice around the centre: [q, r] axial coordinates, ring by ring. */
function hexCells(n: number): Array<{ q: number; r: number; ring: number }> {
  const dirs = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  const cells = [{ q: 0, r: 0, ring: 0 }];
  for (let k = 1; cells.length < n; k++) {
    let q = -k, r = k; // start at direction 4 * k, walk the ring
    for (let side = 0; side < 6; side++) {
      for (let step = 0; step < k; step++) {
        cells.push({ q, r, ring: k });
        q += dirs[side][0];
        r += dirs[side][1];
      }
    }
  }
  return cells.slice(0, n);
}
const hexDistance = (a: { q: number; r: number }, b: { q: number; r: number }) =>
  (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;

const r5 = (x: number) => Math.round(x * 1e5) / 1e5;

/**
 * Great-circle distance in km between two pins. ESI and templates give positions in radians, the "latitude" being measured
 * from the pole (0 to pi; real colonies sit around 1-2.5), so the haversine takes its sine where a latitude would take
 * the cosine.
 */
export function pinDistanceKm(a: { La: number; Lo: number }, b: { La: number; Lo: number }, radiusKm: number): number {
  const h = Math.sin((b.La - a.La) / 2) ** 2 + Math.sin(a.La) * Math.sin(b.La) * Math.sin((b.Lo - a.Lo) / 2) ** 2;
  return 2 * radiusKm * Math.asin(Math.min(1, Math.sqrt(h)));
}

function linkLength(t: PiTemplate): number {
  return t.L.reduce((km, l) => km + pinDistanceKm(t.P[l.S - 1], t.P[l.D - 1], t.Diam / 2), 0);
}

export interface TemplateInput {
  layout: Layout;
  planetType: string;
  name: string;
  /** Planet diameter in km (default DEFAULT_DIAMETER_KM). */
  diameterKm?: number;
  /** Extractor program length, for the extractor routes' quantity per cycle (default 24). */
  programHours?: number;
}

/**
 * A hub template for a layout: the launchpad in the middle, structures on a hex lattice around it, each linked to its
 * neighbour one ring in, and every route through the launchpad (extractors deliver to it, factories take their inputs
 * from it and return their output to it), like the build sheets.
 */
export function buildTemplate(sde: Sde, pi: PiData, t: TemplateInput): TemplateResult {
  const pins = planetPins(sde, pi).get(t.planetType);
  if (!pins) throw new Error(`no PI structures for ${t.planetType}`);
  const l = t.layout;
  type Node = { T: number; S: number | null; H: number; kind: "pad" | "factory" | "ecu" | "storage"; resource?: number; perHour?: number };
  const nodes: Node[] = [{ T: pins.launchpad, S: null, H: 0, kind: "pad" }];
  // Factories next to the launchpad (they carry the most routes), then extractors and storage further out.
  for (const f of [...l.factories].sort((a, b) => pi.tier.get(a.product)! - pi.tier.get(b.product)!)) {
    const tier = pi.tier.get(f.product)!;
    const T = tier === 1 ? pins.basic : tier === 4 ? pins.highTech : pins.advanced;
    if (!T) throw new Error(`${t.planetType} has no factory for ${sde.typeName(f.product)}`);
    for (let i = 0; i < f.count; i++) nodes.push({ T, S: f.product, H: 0, kind: "factory" });
  }
  for (const e of l.extractors) nodes.push({ T: pins.ecu, S: e.resource, H: e.heads, kind: "ecu", resource: e.resource, perHour: e.perHour });
  for (let i = 0; i < l.storage; i++) nodes.push({ T: pins.storage, S: null, H: 0, kind: "storage" });
  for (let i = 1; i < l.launchpads; i++) nodes.push({ T: pins.launchpad, S: null, H: 0, kind: "storage" });

  const cells = hexCells(nodes.length);
  // Each structure links to a neighbour one ring in, preferring a factory or the launchpad (they pass routes on).
  const parent = cells.map((c, i) => {
    if (i === 0) return -1;
    const inner = cells.map((x, j) => ({ x, j })).filter(({ x, j }) => j < i && x.ring === c.ring - 1 && hexDistance(x, c) === 1);
    return (inner.find(({ j }) => nodes[j].kind === "pad" || nodes[j].kind === "factory") ?? inner[0]).j;
  });
  const centre = { La: Math.PI / 2, Lo: Math.PI };
  const P = nodes.map((n, i) => {
    const x = TEMPLATE_SPACING * (cells[i].q + cells[i].r / 2);
    const y = TEMPLATE_SPACING * cells[i].r * (Math.sqrt(3) / 2);
    const La = centre.La + y;
    return { H: n.H, La: r5(La), Lo: r5(centre.Lo + x / Math.sin(La)), S: n.S, T: n.T };
  });
  const L = parent.flatMap((p, i) => (p < 0 ? [] : [{ D: p + 1, Lv: 0, S: i + 1 }]));
  const toPad = (i: number) => {
    const path = [i + 1];
    for (let j = parent[i]; j >= 0; j = parent[j]) path.push(j + 1);
    return path;
  };
  const R: PiTemplate["R"] = [];
  const cycle = programCycleSeconds(t.programHours ?? 24);
  nodes.forEach((n, i) => {
    if (n.kind === "ecu") R.push({ P: toPad(i), Q: Math.max(1, Math.round((n.perHour ?? 0) * (cycle / 3600))), T: n.resource! });
    if (n.kind !== "factory") return;
    const s = pi.schematic.get(n.S!)!;
    for (const [input, q] of s.inputs) R.push({ P: toPad(i).reverse(), Q: q, T: input });
    R.push({ P: toPad(i), Q: s.outputQty, T: n.S! });
  });
  const template: PiTemplate = {
    CmdCtrLv: l.ccLevel, Cmt: t.name, Diam: Math.round(t.diameterKm ?? DEFAULT_DIAMETER_KM), L, P, Pln: planetTypeId(pi, t.planetType), R,
  };
  return { template, links: { count: L.length, totalKm: t.diameterKm ? linkLength(template) : 0 } };
}

/** A template copied from a real colony (ESI /characters/{id}/planets/{planet}): same structures, positions, links and routes. */
export function templateFromEsi(
  sde: Sde, pi: PiData, esi: any, s: { planetType: string; ccLevel: number; name: string; diameterKm?: number },
): TemplateResult {
  const pins = (esi?.pins ?? []).filter((p: any) => sde.type(p.type_id)?.group_id !== PI_GROUP.commandCenter);
  const index = new Map<number, number>(pins.map((p: any, i: number) => [p.pin_id, i + 1]));
  const bySchematic = new Map([...pi.schematic.values()].map((x) => [x.id, x.output]));
  const P = pins.map((p: any) => {
    const ex = p.extractor_details;
    const sid = p.schematic_id ?? p.factory_details?.schematic_id;
    return {
      H: ex ? (ex.heads?.length ?? 0) : 0,
      La: r5(p.latitude), Lo: r5(p.longitude),
      S: ex?.product_type_id ?? (sid ? bySchematic.get(sid) ?? null : null),
      T: p.type_id,
    };
  });
  const L = (esi?.links ?? [])
    .filter((l: any) => index.has(l.source_pin_id) && index.has(l.destination_pin_id))
    .map((l: any) => ({ D: index.get(l.destination_pin_id)!, Lv: l.link_level ?? 0, S: index.get(l.source_pin_id)! }));
  const R = (esi?.routes ?? [])
    .map((r: any) => ({ P: [r.source_pin_id, ...(r.waypoints ?? []), r.destination_pin_id].map((id: number) => index.get(id)), Q: r.quantity, T: r.content_type_id }))
    .filter((r: any) => r.P.every((x: number | undefined) => x != null));
  const template: PiTemplate = {
    CmdCtrLv: s.ccLevel, Cmt: s.name, Diam: Math.round(s.diameterKm ?? DEFAULT_DIAMETER_KM), L, P, Pln: planetTypeId(pi, s.planetType), R,
  };
  return { template, links: { count: L.length, totalKm: s.diameterKm ? linkLength(template) : 0 } };
}

/** File name for a template: the name without characters Windows doesn't allow. */
export const templateFileName = (name: string) => `${name.replace(/[<>:"/\\|?*]+/g, "-").trim()}.json`;
