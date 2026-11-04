import type { Sde } from "./sde/db.js";
import { PI_ATTR, PI_GROUP, perHour, type PiData } from "./pi.js";

/**
 * Deterministic colony model shared by pi_colony_calc and pi_optimize: what a layout costs in CPU/powergrid, whether
 * it fits a command center, and what it produces per hour given its extractors' output. Inputs flow up the tiers:
 * extractors feed basic factories, P1 feeds advanced factories, and so on. A factory short of input runs at the share
 * its scarcest input allows.
 */

export interface Flow { type: number; perHour: number }
export interface Cost { cpu: number; pg: number }

/** Command center CPU / powergrid by upgrade level (game client values; not in the SDE). */
export const CC_LEVELS: Array<{ cpu: number; pg: number }> = [
  { cpu: 1675, pg: 6000 },
  { cpu: 7057, pg: 9000 },
  { cpu: 12136, pg: 12000 },
  { cpu: 17215, pg: 15000 },
  { cpu: 21315, pg: 17000 },
  { cpu: 25415, pg: 19000 },
];

/** Share of CPU/PG kept free for links when their lengths aren't given. */
export const LINK_RESERVE = 0.06;
/** Link cost: base per link plus per km (game client values, EVE University). */
export const LINK_COST = { cpuBase: 15, cpuPerKm: 0.2, pgBase: 10, pgPerKm: 0.15 } as const;
/** Launchpad, storage facility and command center capacity in m3 (game client values; not in the SDE). */
export const LAUNCHPAD_M3 = 10000;
export const STORAGE_M3 = 12000;
export const COMMAND_CENTER_M3 = 500;
export const MAX_HEADS = 10;
/** P0 one basic industry facility processes per hour (3,000 per 30-minute cycle). */
export const BASIC_P0_PER_HOUR = 6000;

const ATTR_HEAD_CPU = 1690;
const ATTR_HEAD_PG = 1691;

export interface PinCosts {
  ecu: Cost;
  head: Cost;
  basic: Cost;
  advanced: Cost;
  highTech: Cost;
  storage: Cost;
  launchpad: Cost;
}

/** Structure CPU/PG from the SDE (identical across planet types, so the first of each group is used). */
export function pinCosts(sde: Sde): PinCosts {
  const cost = (id: number | undefined): Cost => ({
    cpu: id ? sde.attr(id, PI_ATTR.cpuLoad) ?? 0 : 0,
    pg: id ? sde.attr(id, PI_ATTR.powerLoad) ?? 0 : 0,
  });
  const byName = (group: number, re: RegExp) => sde.typeIdsInGroups([group]).find((id) => re.test(sde.typeName(id)));
  const ecu = sde.typeIdsInGroups([1063])[0];
  return {
    ecu: cost(ecu),
    head: { cpu: ecu ? sde.attr(ecu, ATTR_HEAD_CPU) ?? 110 : 110, pg: ecu ? sde.attr(ecu, ATTR_HEAD_PG) ?? 550 : 550 },
    basic: cost(byName(PI_GROUP.processor, /Basic/)),
    advanced: cost(byName(PI_GROUP.processor, /Advanced/)),
    highTech: cost(byName(PI_GROUP.processor, /High-Tech/)),
    storage: cost(sde.typeIdsInGroups([1029])[0]),
    launchpad: cost(sde.typeIdsInGroups([1030])[0]),
  };
}

export const addCosts = (...cs: Array<[Cost, number]>): Cost =>
  cs.reduce((a, [c, n]) => ({ cpu: a.cpu + c.cpu * n, pg: a.pg + c.pg * n }), { cpu: 0, pg: 0 });

export interface Layout {
  ccLevel: number;
  /** One entry per extractor control unit, with its output already worked out. */
  extractors: Array<{ resource: number; heads: number; perHour: number }>;
  /** Factories by product (tier decides the building: P1 basic, P2/P3 advanced, P4 high-tech). */
  factories: Array<{ product: number; count: number }>;
  storage: number;
  launchpads: number;
  /** Explicit links; when absent, LINK_RESERVE of the command center is kept free instead. */
  links?: { count: number; totalKm: number };
  /** Goods brought in per hour (from other colonies or bought). */
  imports?: Flow[];
  /** Bring in whatever the factories lack (counted as bought). */
  buyMissing?: boolean;
}

export function factoryCost(costs: PinCosts, pi: PiData, product: number): Cost {
  const t = pi.tier.get(product);
  return t === 1 ? costs.basic : t === 4 ? costs.highTech : costs.advanced;
}

export function layoutCost(costs: PinCosts, pi: PiData, l: Layout): Cost {
  const heads = l.extractors.reduce((n, e) => n + Math.max(0, e.heads - 1), 0);
  const base = addCosts(
    [costs.launchpad, l.launchpads], [costs.storage, l.storage], [costs.ecu, l.extractors.length], [costs.head, heads],
    ...l.factories.map((f) => [factoryCost(costs, pi, f.product), f.count] as [Cost, number]),
  );
  if (!l.links) return base;
  return {
    cpu: base.cpu + LINK_COST.cpuBase * l.links.count + LINK_COST.cpuPerKm * l.links.totalKm,
    pg: base.pg + LINK_COST.pgBase * l.links.count + LINK_COST.pgPerKm * l.links.totalKm,
  };
}

/** CPU/PG the layout may use: the command center's, minus the link reserve when links aren't given. */
export function layoutCapacity(l: Layout): Cost {
  const cc = CC_LEVELS[Math.max(0, Math.min(l.ccLevel, 5))];
  const keep = l.links ? 1 : 1 - LINK_RESERVE;
  return { cpu: cc.cpu * keep, pg: cc.pg * keep };
}

export function layoutFits(costs: PinCosts, pi: PiData, l: Layout): boolean {
  const used = layoutCost(costs, pi, l);
  const cap = layoutCapacity(l);
  return used.cpu <= cap.cpu + 1e-9 && used.pg <= cap.pg + 1e-9;
}

export interface Simulation {
  /** Product -> share of the time its factories run (0..1). */
  utilisation: Map<number, number>;
  /** Per hour: made by extractors and factories, consumed by factories, bought in to fill gaps. */
  made: Map<number, number>;
  consumed: Map<number, number>;
  bought: Map<number, number>;
  /** Per hour: what is left over (exported, or piling up for P0). */
  leftover: Map<number, number>;
}

/** Runs the layout's production chain for an hour, lowest tier first. */
export function simulate(pi: PiData, l: Layout): Simulation {
  const supply = new Map<number, number>();
  const made = new Map<number, number>();
  const consumed = new Map<number, number>();
  const bought = new Map<number, number>();
  const utilisation = new Map<number, number>();
  const bump = (m: Map<number, number>, k: number, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  for (const e of l.extractors) { bump(supply, e.resource, e.perHour); bump(made, e.resource, e.perHour); }
  for (const f of l.imports ?? []) bump(supply, f.type, f.perHour);

  for (let tier = 1; tier <= 4; tier++) {
    const group = l.factories.filter((f) => pi.tier.get(f.product) === tier && f.count > 0 && pi.schematic.has(f.product));
    // Total demand per input across this tier's factories at full speed.
    const demand = new Map<number, number>();
    for (const f of group) for (const [i, q] of pi.schematic.get(f.product)!.inputs) bump(demand, i, ((q * 3600) / pi.schematic.get(f.product)!.cycle) * f.count);
    if (l.buyMissing) {
      for (const [i, d] of demand) {
        const gap = d - (supply.get(i) ?? 0);
        if (gap > 1e-9) { bump(bought, i, gap); bump(supply, i, gap); }
      }
    }
    // Shared inputs are split in proportion to demand; a factory runs at its scarcest input's share.
    const share = new Map([...demand].map(([i, d]) => [i, Math.min(1, (supply.get(i) ?? 0) / d)]));
    for (const f of group) {
      const s = pi.schematic.get(f.product)!;
      const u = Math.min(1, ...s.inputs.map(([i]) => share.get(i) ?? 0));
      utilisation.set(f.product, u);
      for (const [i, q] of s.inputs) {
        const use = ((q * 3600) / s.cycle) * f.count * u;
        bump(consumed, i, use);
        supply.set(i, (supply.get(i) ?? 0) - use);
      }
      const out = perHour(pi, f.product) * f.count * u;
      bump(made, f.product, out);
      bump(supply, f.product, out);
    }
  }
  const leftover = new Map([...supply].filter(([, v]) => v > 1e-6));
  return { utilisation, made, consumed, bought, leftover };
}
