import type { Sde } from "./sde/db.js";
import { PI_ATTR, PI_GROUP, perHour, tierName, type PiData } from "./pi.js";

/**
 * Planetary interaction optimiser: given a system's planets with the player's scan readings, market prices and the
 * colony slots of every character, pick a role for each slot (extraction colony or factory colony) that maximises
 * ISK per day. Deterministic greedy assignment over enumerated colony templates; every number it uses is reported
 * as observed (prices, skills), scanned (abundance) or assumed (yield per scan point, fees). See
 * docs/PLANETARY_INTERACTION.md section 5.
 */

/** Command center CPU / powergrid by upgrade level (game client values; not in the SDE). */
export const CC_LEVELS: Array<{ cpu: number; pg: number }> = [
  { cpu: 1675, pg: 6000 },
  { cpu: 7057, pg: 9000 },
  { cpu: 12136, pg: 12000 },
  { cpu: 17215, pg: 15000 },
  { cpu: 21315, pg: 17000 },
  { cpu: 25415, pg: 19000 },
];

/** Share of CPU/PG kept free for links, which depend on layout. */
const LINK_RESERVE = 0.06;
const MAX_HEADS = 10;
const ATTR_HEAD_CPU = 1690;
const ATTR_HEAD_PG = 1691;

export interface Cost { cpu: number; pg: number }

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

export interface Price {
  /** Lowest sell order: what you pay to buy now, and what a sell order lists at. */
  sell: number;
  /** Average units traded per day in the region (7 days), when known. */
  dailyVolume?: number;
}

export interface PlanetInput {
  id: number;
  name: string;
  type: string;
  /** P0 type id -> scan reading 0-100. */
  abundance: Map<number, number>;
}

export interface Slot {
  character: string;
  slots: number;
  ccLevel: number;
}

export interface OptimizeParams {
  /** P0 per hour one 10-head extractor gives on a resource that scans 100. */
  yieldAtFull: number;
  /** Customs office tax, 0-1. */
  taxRate: number;
  /** Fees when selling (sales tax + broker), 0-1. */
  sellFee: number;
  /** Max share of an item's daily market volume the plan may buy or sell, 0-1. */
  liquidityShare: number;
  /** Max characters extracting on one planet. */
  maxCharactersPerPlanet: number;
  /** Consider factory colonies that run on bought inputs. */
  factories: boolean;
  /** ISK per day the plan may spend buying factory inputs. */
  maxCapitalPerDay: number;
  /** m3 per day the plan may haul in and out of the system (imports plus exports). */
  maxHaulPerDay: number;
  /** Days between visits to a factory colony: its inputs for that long must fit its launchpad and storage. */
  restockDays: number;
}

/** Launchpad and storage facility capacity in m3 (game client values; not in the SDE). */
export const LAUNCHPAD_M3 = 10000;
export const STORAGE_M3 = 12000;

interface Flow { type: number; perHour: number }

export interface Colony {
  kind: "extraction" | "factory";
  planet: PlanetInput;
  ccLevel: number;
  /** ISK per hour after fees and customs tax (factories: after buying inputs). */
  iskPerHour: number;
  /** ISK per hour spent buying inputs (factories). */
  capitalPerHour: number;
  outputs: Flow[];
  inputs: Flow[];
  describe: string;
  /** Extraction: the P0 types extracted. Factory: the product. */
  key: string;
  product?: number;
  factories?: number;
}

const fits = (c: Cost, cc: { cpu: number; pg: number }) =>
  c.cpu <= cc.cpu * (1 - LINK_RESERVE) && c.pg <= cc.pg * (1 - LINK_RESERVE);
const add = (...cs: Array<[Cost, number]>): Cost =>
  cs.reduce((a, [c, n]) => ({ cpu: a.cpu + c.cpu * n, pg: a.pg + c.pg * n }), { cpu: 0, pg: 0 });

/** The P2 made from exactly these two P1, if any. */
function p2From(pi: PiData, a: number, b: number): number | undefined {
  for (const [out, s] of pi.schematic) {
    if (pi.tier.get(out) !== 2) continue;
    const ins = s.inputs.map(([i]) => i);
    if (ins.length === 2 && ins.includes(a) && ins.includes(b)) return out;
  }
  return undefined;
}

/** P1 made from a P0. */
function p1From(pi: PiData, p0: number): number | undefined {
  for (const [out, s] of pi.schematic) if (pi.tier.get(out) === 1 && s.inputs[0]?.[0] === p0) return out;
  return undefined;
}

interface Ctx {
  sde: Sde;
  pi: PiData;
  costs: PinCosts;
  prices: Map<number, Price>;
  params: OptimizeParams;
}

const taxBase = (c: Ctx, type: number) => c.sde.attr(type, PI_ATTR.exportTaxBase) ?? 0;
const saleValue = (c: Ctx, type: number, perHour: number) => {
  const p = c.prices.get(type)?.sell;
  if (!p) return null;
  return perHour * (p * (1 - c.params.sellFee) - taxBase(c, type) * c.params.taxRate);
};

/**
 * Best extraction colony on a planet for two extractors on resources r1 and r2 (may be the same resource): the head
 * count that fits the command center, then either sell both P1 or combine them into a P2, whichever pays more.
 */
export function extractionColony(c: Ctx, planet: PlanetInput, r1: number, r2: number, ccLevel: number): Colony | null {
  const cc = CC_LEVELS[Math.min(ccLevel, 5)];
  const { costs, pi, params } = c;
  const p1a = p1From(pi, r1);
  const p1b = p1From(pi, r2);
  if (!p1a || !p1b) return null;
  const p2 = r1 === r2 ? undefined : p2From(pi, p1a, p1b);
  let best: Colony | null = null;
  for (const makeP2 of p2 ? [true, false] : [false]) {
    for (let heads = MAX_HEADS; heads >= 1; heads--) {
      const y = (r: number) => params.yieldAtFull * ((planet.abundance.get(r) ?? 0) / 100) * (heads / MAX_HEADS);
      const p0 = new Map<number, number>();
      p0.set(r1, (p0.get(r1) ?? 0) + y(r1));
      p0.set(r2, (p0.get(r2) ?? 0) + y(r2));
      const basicCount = [...p0.values()].reduce((n, rate) => n + Math.max(1, Math.ceil(rate / 6000)), 0);
      const p1Rate = new Map([...p0].map(([r, rate]) => [p1From(pi, r)!, Math.min(rate, Math.ceil(rate / 6000) * 6000) / 150]));
      let adv = 0;
      const outputs: Flow[] = [];
      if (makeP2 && p2) {
        const pairs = Math.min(p1Rate.get(p1a)!, p1Rate.get(p1b)!) / 40;
        adv = Math.max(1, Math.ceil(pairs - 1e-9));
        const p2Rate = Math.min(pairs, adv) * 5;
        outputs.push({ type: p2, perHour: p2Rate });
        for (const [t, r] of p1Rate) {
          const left = r - (p2Rate / 5) * 40;
          if (left > 0.01) outputs.push({ type: t, perHour: left });
        }
      } else for (const [t, r] of p1Rate) outputs.push({ type: t, perHour: r });
      const cost = add([costs.launchpad, 1], [costs.ecu, 2], [costs.head, 2 * (heads - 1)], [costs.basic, basicCount], [costs.advanced, adv]);
      if (!fits(cost, cc)) continue;
      const values = outputs.map((o) => saleValue(c, o.type, o.perHour));
      if (values.some((v) => v == null)) break;
      const isk = values.reduce((a, v) => a! + v!, 0)!;
      const ab = (r: number) => planet.abundance.get(r) ?? 0;
      const res = r1 === r2 ? `2 x ${c.sde.typeName(r1)} (${ab(r1)})` : `${c.sde.typeName(r1)} (${ab(r1)}) + ${c.sde.typeName(r2)} (${ab(r2)})`;
      const out = outputs.map((o) => `${c.sde.typeName(o.type)} ${Math.round(o.perHour * 24).toLocaleString("en-US")}/day (${tierName(pi.tier.get(o.type))})`).join(", ");
      const colony: Colony = {
        kind: "extraction", planet, ccLevel, iskPerHour: isk, capitalPerHour: 0, outputs, inputs: [],
        key: [r1, r2].sort().join("+"),
        describe: `extract ${res}, ${heads} heads per extractor, ${basicCount} basic${adv ? ` + ${adv} advanced` : ""} -> ${out}`,
      };
      if (!best || colony.iskPerHour > best.iskPerHour) best = colony;
      break; // the most heads that fit is the best for this mode
    }
  }
  return best;
}

/** How many factories of a product fit a command center next to a launchpad and one storage facility. */
export function factoriesThatFit(c: Ctx, product: number, ccLevel: number): number {
  const cc = CC_LEVELS[Math.min(ccLevel, 5)];
  const f = c.pi.tier.get(product) === 4 ? c.costs.highTech : c.costs.advanced;
  const base = add([c.costs.launchpad, 1], [c.costs.storage, 1]);
  let n = 0;
  while (fits(add([base, 1], [f, n + 1]), cc)) n++;
  return n;
}

/** Per factory-hour economics of making `product` from bought inputs. */
export function factoryMargin(c: Ctx, product: number): { isk: number; capital: number; inputs: Flow[]; output: Flow } | null {
  const s = c.pi.schematic.get(product);
  if (!s) return null;
  const rate = perHour(c.pi, product);
  const value = saleValue(c, product, rate);
  if (value == null) return null;
  let capital = 0;
  let importTax = 0;
  const inputs: Flow[] = [];
  for (const [i, q] of s.inputs) {
    const p = c.prices.get(i)?.sell;
    if (!p) return null;
    const n = (q * 3600) / s.cycle;
    capital += n * p;
    importTax += n * taxBase(c, i) * c.params.taxRate * 0.5;
    inputs.push({ type: i, perHour: n });
  }
  return { isk: value - capital - importTax, capital, inputs, output: { type: product, perHour: rate } };
}

export interface Plan {
  assignments: Array<{ character: string; ccLevel: number; colonies: Colony[] }>;
  unused: Array<{ character: string; slots: number }>;
  unusedReason?: string;
  totals: { haulIn: number; haulOut: number; capitalPerDay: number };
  /** Units per hour the plan's colonies make that it exports and sells as they are. */
  remainingLocal: Flow[];
  bestByPlanet: Map<string, Colony[]>;
  factoryMargins: Array<{ product: number; iskPerHour: number }>;
  warnings: string[];
}

/** Greedy plan: repeatedly give the most valuable remaining colony to a character with a free slot on that planet. */
export function optimize(
  sde: Sde, pi: PiData, costs: PinCosts, prices: Map<number, Price>, planets: PlanetInput[], slots: Slot[], params: OptimizeParams,
): Plan {
  const c: Ctx = { sde, pi, costs, prices, params };
  const warnings: string[] = [];
  const levels = [...new Set(slots.map((s) => Math.min(s.ccLevel, 5)))];

  // Extraction candidates per planet and CC level.
  const extraction = new Map<number, Colony[]>(); // ccLevel -> colonies
  const bestByPlanet = new Map<string, Colony[]>();
  for (const lvl of levels) {
    const list: Colony[] = [];
    for (const planet of planets) {
      const res = [...planet.abundance.keys()];
      for (let i = 0; i < res.length; i++) for (let j = i; j < res.length; j++) {
        const col = extractionColony(c, planet, res[i], res[j], lvl);
        if (col && col.iskPerHour > 0) list.push(col);
      }
    }
    list.sort((a, b) => b.iskPerHour - a.iskPerHour);
    extraction.set(lvl, list);
    if (lvl === Math.max(...levels)) {
      for (const planet of planets) bestByPlanet.set(planet.name, list.filter((x) => x.planet.id === planet.id).slice(0, 3));
    }
  }

  // Factory candidates: every P2-P4 product with prices. Margins from bought inputs are reported; the greedy loop
  // re-prices each candidate with whatever the plan's own colonies already produce.
  const margins: Array<{ product: number; iskPerHour: number }> = [];
  const products: number[] = [];
  if (params.factories) {
    for (const [product, t] of pi.tier) {
      if (t < 2 || !pi.schematic.has(product)) continue;
      const m = factoryMargin(c, product);
      if (!m) continue;
      products.push(product);
      if (m.isk > 0) margins.push({ product, iskPerHour: m.isk });
    }
    margins.sort((a, b) => b.iskPerHour - a.iskPerHour);
  }
  const highTechPlanets = planets.filter((p) => pi.highTech.has(p.type));

  const vol = (type: number) => sde.type(type)?.volume ?? 0;
  const m3 = (flows: Flow[]) => flows.reduce((s, f) => s + vol(f.type) * f.perHour * 24, 0);
  let capitalLeft = params.maxCapitalPerDay;
  let haulLeft = params.maxHaulPerDay;
  let haulIn = 0;
  let haulOut = 0;

  // Local supply: units per day the plan's colonies make and would otherwise export and sell.
  const pool = new Map<number, number>();

  // Liquidity budget per item (units per day the plan may buy or sell).
  const used = new Map<number, number>();
  const room = (type: number) => {
    const v = prices.get(type)?.dailyVolume;
    return v == null ? Infinity : v * params.liquidityShare - (used.get(type) ?? 0);
  };

  /** A factory colony of `n` factories, taking inputs from the local pool first and buying the rest. */
  const factoryColony = (
    product: number, n: number, planet: PlanetInput, lvl: number, check = true,
  ): (Colony & { haul: number; poolUse: Flow[] }) | null => {
    const s = pi.schematic.get(product)!;
    const outPerHour = perHour(pi, product) * n;
    const outValue = saleValue(c, product, outPerHour);
    if (outValue == null) return null;
    let isk = outValue;
    let capital = 0;
    let haul = m3([{ type: product, perHour: outPerHour }]);
    let storeM3 = 0;
    const bought: Flow[] = [];
    const local: Flow[] = [];
    for (const [i, q] of s.inputs) {
      const need = ((q * 3600) / s.cycle) * n; // per hour
      const fromPool = Math.min(need, (pool.get(i) ?? 0) / 24);
      const buy = need - fromPool;
      const price = prices.get(i)?.sell;
      if (buy > 1e-9 && !price) return null;
      // Local inputs are no longer sold (lose their net sale value) and no longer hauled out.
      if (fromPool > 0) {
        isk -= saleValue(c, i, fromPool) ?? 0;
        haul -= vol(i) * fromPool * 24;
        local.push({ type: i, perHour: fromPool });
      }
      if (buy > 1e-9) {
        capital += buy * price!;
        isk -= buy * price!;
        haul += vol(i) * buy * 24;
        bought.push({ type: i, perHour: buy });
        if (check && room(i) < buy * 24) return null;
      }
      isk -= need * taxBase(c, i) * params.taxRate * 0.5; // import into the factory planet
      storeM3 += vol(i) * need * 24 * params.restockDays;
    }
    if (check) {
      if (room(product) < outPerHour * 24) return null;
      if (storeM3 > LAUNCHPAD_M3 + STORAGE_M3) return null;
      if (capital * 24 > capitalLeft || haul > haulLeft) return null;
    }
    const fmt = (f: Flow) => `${sde.typeName(f.type)} ${Math.round(f.perHour * 24).toLocaleString("en-US")}/day`;
    const parts = [
      local.length ? `your colonies' ${local.map(fmt).join(", ")}` : "",
      bought.length ? `bought ${bought.map(fmt).join(", ")}` : "",
    ].filter(Boolean).join(" + ");
    return {
      kind: "factory", planet, ccLevel: lvl, iskPerHour: isk, capitalPerHour: capital,
      outputs: [{ type: product, perHour: outPerHour }], inputs: bought, poolUse: local, haul,
      describe: `factory: ${n} x ${pi.factoryName.get(pi.tier.get(product)!)} making ${sde.typeName(product)} from ${parts} ` +
        `-> ${Math.round(outPerHour * 24).toLocaleString("en-US")}/day`,
      key: String(product), product, factories: n,
    };
  };

  const free = new Map(slots.map((s) => [s.character, s.slots]));
  const onPlanet = new Map<string, Set<number>>(slots.map((s) => [s.character, new Set()]));
  const extractorsOn = new Map<number, number>();
  const taken = new Set<string>(); // planet + resource pair already extracted by someone
  const assignments = new Map<string, Colony[]>(slots.map((s) => [s.character, []]));

  for (;;) {
    let pick: { slot: Slot; colony: Colony & { haul?: number; poolUse?: Flow[] } } | null = null;
    for (const slot of slots) {
      if (!free.get(slot.character)) continue;
      const mine = onPlanet.get(slot.character)!;
      const lvl = Math.min(slot.ccLevel, 5);
      const ex = (extraction.get(lvl) ?? []).find((col) =>
        !mine.has(col.planet.id) &&
        m3(col.outputs) <= haulLeft &&
        (extractorsOn.get(col.planet.id) ?? 0) < params.maxCharactersPerPlanet &&
        // The same resources twice on one planet would compete for the same deposits.
        !taken.has(`${col.planet.id}:${col.key}`));
      if (ex && (!pick || ex.iskPerHour > pick.colony.iskPerHour)) pick = { slot, colony: ex };
      for (const product of products) {
        const where = (pi.tier.get(product) === 4 ? highTechPlanets : planets).find((p) => !mine.has(p.id));
        if (!where) continue;
        // Try every factory count that fits the command center; keep the most valuable.
        for (let n = factoriesThatFit(c, product, lvl); n >= 1; n--) {
          const col = factoryColony(product, n, where, lvl);
          if (col && col.iskPerHour > 0 && (!pick || col.iskPerHour > pick.colony.iskPerHour)) pick = { slot, colony: col };
        }
      }
    }
    if (!pick) break;
    const { slot, colony } = pick;
    assignments.get(slot.character)!.push(colony);
    free.set(slot.character, free.get(slot.character)! - 1);
    onPlanet.get(slot.character)!.add(colony.planet.id);
    if (colony.kind === "extraction") {
      extractorsOn.set(colony.planet.id, (extractorsOn.get(colony.planet.id) ?? 0) + 1);
      taken.add(`${colony.planet.id}:${colony.key}`);
      haulLeft -= m3(colony.outputs);
      haulOut += m3(colony.outputs);
    } else {
      for (const f of colony.poolUse ?? []) {
        pool.set(f.type, (pool.get(f.type) ?? 0) - f.perHour * 24);
        haulOut -= vol(f.type) * f.perHour * 24;
      }
      for (const f of colony.inputs) used.set(f.type, (used.get(f.type) ?? 0) + f.perHour * 24);
      capitalLeft -= colony.capitalPerHour * 24;
      haulLeft -= colony.haul ?? 0;
      haulIn += m3(colony.inputs);
      haulOut += m3(colony.outputs);
    }
    for (const f of colony.outputs) {
      used.set(f.type, (used.get(f.type) ?? 0) + f.perHour * 24);
      pool.set(f.type, (pool.get(f.type) ?? 0) + f.perHour * 24);
    }
  }

  // Rebalance: factories were priced against the local supply that existed when each was picked, so a factory chosen
  // early may buy inputs that later colonies make. Re-split every factory's inputs, lowest tier first, so local
  // output feeds factories before anything is bought.
  pool.clear();
  haulIn = 0;
  haulOut = 0;
  let capitalPerDay = 0;
  const allColonies = [...assignments.values()].flat();
  for (const col of allColonies.filter((x) => x.kind === "extraction")) {
    for (const f of col.outputs) pool.set(f.type, (pool.get(f.type) ?? 0) + f.perHour * 24);
    haulOut += m3(col.outputs);
  }
  const factoriesByTier = allColonies.filter((x) => x.kind === "factory")
    .sort((a, b) => pi.tier.get(a.product!)! - pi.tier.get(b.product!)!);
  for (const col of factoriesByTier) {
    const again = factoryColony(col.product!, col.factories!, col.planet, col.ccLevel, false);
    if (!again) continue;
    Object.assign(col, { iskPerHour: again.iskPerHour, capitalPerHour: again.capitalPerHour, inputs: again.inputs, describe: again.describe });
    for (const f of again.poolUse) {
      pool.set(f.type, (pool.get(f.type) ?? 0) - f.perHour * 24);
      haulOut -= vol(f.type) * f.perHour * 24;
    }
    for (const f of again.outputs) pool.set(f.type, (pool.get(f.type) ?? 0) + f.perHour * 24);
    haulIn += m3(again.inputs);
    haulOut += m3(again.outputs);
    capitalPerDay += again.capitalPerHour * 24;
  }

  for (const [type, u] of used) {
    const v = prices.get(type)?.dailyVolume;
    if (v && u > v * 0.05) {
      warnings.push(`${sde.typeName(type)}: the plan trades ${Math.round(u).toLocaleString("en-US")}/day, ${Math.round((u / v) * 100)}% of the market's daily volume.`);
    }
  }
  const unused = slots.filter((s) => free.get(s.character)).map((s) => ({ character: s.character, slots: free.get(s.character)! }));
  const why: string[] = [];
  if (unused.length) {
    if (haulLeft < 500) why.push("the haul budget is used up (raise max_haul_m3_per_day)");
    if (capitalLeft < params.maxCapitalPerDay * 0.05) why.push("the input budget is used up (raise max_input_isk_per_day)");
    if (planets.every((p) => (extractorsOn.get(p.id) ?? 0) >= params.maxCharactersPerPlanet)) {
      why.push(`every planet already has ${params.maxCharactersPerPlanet} extracting characters (raise max_characters_per_planet)`);
    }
    if (!why.length) why.push("no remaining colony adds value at current prices and limits");
  }
  return {
    assignments: slots.map((s) => ({ character: s.character, ccLevel: s.ccLevel, colonies: assignments.get(s.character)! })),
    unused,
    unusedReason: why.join("; ") || undefined,
    totals: { haulIn, haulOut, capitalPerDay },
    remainingLocal: [...pool].filter(([, n]) => n > 0.5).map(([type, perDay]) => ({ type, perHour: perDay / 24 })),
    bestByPlanet,
    factoryMargins: margins.slice(0, 10),
    warnings,
  };
}
