import type { Sde } from "./sde/db.js";
import { UserError, round } from "./util.js";

/**
 * Planetary interaction model built from the SDE: tiers, schematics, which raw resource (P0) each planet type has,
 * and which planet types can host a High-Tech Production Plant (P4). Nothing here is hard-coded per product, so it
 * follows SDE changes. Research notes: docs/PLANETARY_INTERACTION.md.
 */

export const PI_GROUP = {
  p0: [1032, 1033, 1035],
  p1: 1042,
  p2: 1034,
  p3: 1040,
  p4: 1041,
  extractor: 1026,
  commandCenter: 1027,
  processor: 1028,
} as const;

export const PI_ATTR = { powerLoad: 15, cpuLoad: 49, harvesterType: 709, planetRestriction: 1632, exportTaxBase: 1641 } as const;

export const PI_SKILL = { interplanetaryConsolidation: "Interplanetary Consolidation", commandCenterUpgrades: "Command Center Upgrades" } as const;

export interface Schematic {
  id: number;
  output: number;
  outputQty: number;
  cycle: number;
  inputs: Array<[number, number]>;
}

export interface PiData {
  /** Commodity type id -> tier 0..4. */
  tier: Map<number, number>;
  /** Output type id -> its schematic. */
  schematic: Map<number, Schematic>;
  /** Input type id -> output type ids it feeds. */
  usedIn: Map<number, number[]>;
  /** P0 type id -> planet type names it can be extracted on. */
  p0Planets: Map<number, Set<string>>;
  /** Colonisable planet type id -> short name ("Barren"). Other planet types (Shattered, ...) have no PI. */
  planetType: Map<number, string>;
  /** Planet type names in a stable order. */
  planetTypes: string[];
  /** Planet type names with a High-Tech Production Plant (the only P4 factory). */
  highTech: Set<string>;
  /** Factory name per tier, e.g. "Advanced Industry Facility". */
  factoryName: Map<number, string>;
}

const cache = new WeakMap<Sde, PiData>();
const usedInIndustryCache = new WeakMap<Sde, Map<number, Set<string>>>();

const shortPlanet = (name: string) => name.replace(/^Planet \((.*)\)$/, "$1");

export function piData(sde: Sde): PiData {
  const hit = cache.get(sde);
  if (hit) return hit;
  const schematics = sde.piSchematics();
  if (!schematics.length) {
    throw new UserError("The static data index has no planetary schematics yet. Run `sde-update` (or restart the server) to rebuild it.");
  }
  const tier = new Map<number, number>();
  const groupTier: Array<[readonly number[] | number, number]> = [
    [PI_GROUP.p0, 0], [PI_GROUP.p1, 1], [PI_GROUP.p2, 2], [PI_GROUP.p3, 3], [PI_GROUP.p4, 4],
  ];
  for (const [g, t] of groupTier) for (const id of sde.typeIdsInGroups(Array.isArray(g) ? [...g] : [g as number])) tier.set(id, t);

  const schematic = new Map<number, Schematic>();
  const usedIn = new Map<number, number[]>();
  for (const s of schematics) {
    schematic.set(s.output_type_id, { id: s.id, output: s.output_type_id, outputQty: s.output_qty, cycle: s.cycle_time, inputs: s.inputs });
    for (const [i] of s.inputs) usedIn.set(i, [...(usedIn.get(i) ?? []), s.output_type_id]);
  }

  const planetType = new Map<number, string>();
  for (const cc of sde.typeIdsInGroups([PI_GROUP.commandCenter])) {
    const pt = sde.attr(cc, PI_ATTR.planetRestriction);
    if (pt) planetType.set(pt, shortPlanet(sde.typeName(pt)));
  }
  const p0Planets = new Map<number, Set<string>>();
  for (const ex of sde.typeIdsInGroups([PI_GROUP.extractor])) {
    const res = sde.attr(ex, PI_ATTR.harvesterType);
    const pt = sde.attr(ex, PI_ATTR.planetRestriction);
    if (!res || !pt || !planetType.has(pt)) continue;
    if (!p0Planets.has(res)) p0Planets.set(res, new Set());
    p0Planets.get(res)!.add(planetType.get(pt)!);
  }
  // The P4 schematic's factory pins name the planet types that have a High-Tech Production Plant.
  const highTech = new Set<string>();
  const factoryName = new Map<number, string>();
  for (const pin of sde.typeIdsInGroups([PI_GROUP.processor])) {
    const name = sde.typeName(pin);
    const pt = sde.attr(pin, PI_ATTR.planetRestriction);
    const kind = name.replace(/^\S+\s/, "");
    if (/High-Tech/.test(name) && pt && planetType.has(pt)) highTech.add(planetType.get(pt)!);
    if (/Basic/.test(name)) factoryName.set(1, kind);
    if (/Advanced/.test(name)) { factoryName.set(2, kind); factoryName.set(3, kind); }
    if (/High-Tech/.test(name)) factoryName.set(4, kind);
  }
  const data: PiData = {
    tier, schematic, usedIn, p0Planets, planetType, highTech, factoryName,
    planetTypes: [...new Set(planetType.values())].sort(),
  };
  cache.set(sde, data);
  return data;
}

export const tierName = (t: number | undefined) => (t == null ? "?" : `P${t}`);

/** Resolves a planet type name ("barren", "Planet (Gas)") to its short name, or throws with the valid list. */
export function planetTypeRef(pi: PiData, ref: string): string {
  const want = shortPlanet(ref.trim()).toLowerCase();
  const hit = pi.planetTypes.find((p) => p.toLowerCase() === want);
  if (!hit) throw new UserError(`Unknown planet type "${ref}". Planet types with PI: ${pi.planetTypes.join(", ")}.`);
  return hit;
}

/** The raw (P0) resources a product needs, all the way down. */
export function rawInputs(pi: PiData, typeId: number): Set<number> {
  if (pi.tier.get(typeId) === 0) return new Set([typeId]);
  const s = pi.schematic.get(typeId);
  const out = new Set<number>();
  for (const [i] of s?.inputs ?? []) for (const r of rawInputs(pi, i)) out.add(r);
  return out;
}

/** True if the product can be made from P0 found on these planet types (P4 also needs a High-Tech planet type). */
export function makeableOn(pi: PiData, typeId: number, planetTypes: Iterable<string>): boolean {
  const have = new Set(planetTypes);
  if (pi.tier.get(typeId) === 4 && ![...pi.highTech].some((p) => have.has(p))) return false;
  return [...rawInputs(pi, typeId)].every((r) => [...(pi.p0Planets.get(r) ?? [])].some((p) => have.has(p)));
}

/** Smallest sets of planet types that can make the product on their own (all minimal-size sets). */
export function minimalPlanetSets(pi: PiData, typeId: number): string[][] {
  const types = pi.planetTypes;
  for (let n = 1; n <= types.length; n++) {
    const found: string[][] = [];
    const rec = (start: number, acc: string[]) => {
      if (acc.length === n) { if (makeableOn(pi, typeId, acc)) found.push([...acc]); return; }
      for (let i = start; i < types.length; i++) rec(i + 1, [...acc, types[i]]);
    };
    rec(0, []);
    if (found.length) return found;
  }
  return [];
}

/** Units per hour one factory of this product makes. */
export function perHour(pi: PiData, typeId: number): number {
  const s = pi.schematic.get(typeId);
  return s ? (s.outputQty * 3600) / s.cycle : 0;
}

/**
 * Factories needed to keep one factory of `typeId` running continuously, per product, plus raw P0 per hour.
 * E.g. a P2 factory needs one Basic Industry Facility per P1 input and 6,000 of each P0 per hour.
 */
export function balancedChain(pi: PiData, typeId: number): { factories: Map<number, number>; p0PerHour: Map<number, number> } {
  const factories = new Map<number, number>();
  const p0PerHour = new Map<number, number>();
  const walk = (id: number, count: number) => {
    const s = pi.schematic.get(id);
    if (!s) return;
    factories.set(id, (factories.get(id) ?? 0) + count);
    for (const [input, qty] of s.inputs) {
      const need = (qty * 3600 / s.cycle) * count;
      if (pi.tier.get(input) === 0) p0PerHour.set(input, (p0PerHour.get(input) ?? 0) + need);
      else walk(input, need / perHour(pi, input));
    }
  };
  walk(typeId, 1);
  for (const [k, v] of factories) factories.set(k, round(v, 2));
  return { factories, p0PerHour };
}

/** Group names of the industry products (from blueprints) a PI commodity is a material for, built once per index. */
export function usedInIndustry(sde: Sde, pi: PiData): Map<number, Set<string>> {
  const hit = usedInIndustryCache.get(sde);
  if (hit) return hit;
  const out = new Map<number, Set<string>>();
  for (const bp of sde.allBlueprints()) {
    for (const [activity, a] of Object.entries<any>(bp.activities ?? {})) {
      if (activity !== "manufacturing" && activity !== "reaction") continue;
      for (const m of a.materials ?? []) {
        if (!pi.tier.has(m.typeID)) continue;
        for (const p of a.products ?? []) {
          const t = sde.type(p.typeID);
          if (!t?.published || !t.group) continue;
          if (!out.has(m.typeID)) out.set(m.typeID, new Set());
          out.get(m.typeID)!.add(t.group);
        }
      }
    }
  }
  usedInIndustryCache.set(sde, out);
  return out;
}
