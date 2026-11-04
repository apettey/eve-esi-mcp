import type { Sde } from "./sde/db.js";
import { PI_ATTR, perHour, tierName, type PiData } from "./pi.js";
import { programCycleSeconds, programFactor } from "./pi-colony.js";
import {
  BASIC_P0_PER_HOUR, LAUNCHPAD_M3, MAX_HEADS, STORAGE_M3, layoutFits, simulate, type Flow, type Layout, type PinCosts,
} from "./pi-layout.js";

export { CC_LEVELS, LAUNCHPAD_M3, STORAGE_M3, pinCosts, type Cost, type PinCosts } from "./pi-layout.js";

/**
 * Planetary interaction optimiser: given a system's planets with the player's scan readings, market prices and the
 * colony slots of every character, pick a role for each slot (extraction colony or factory colony) that maximises
 * ISK per day. Deterministic greedy assignment over enumerated colony templates; every number it uses is reported
 * as observed (prices, skills), scanned (abundance) or assumed (yield per scan point, fees). See
 * docs/PLANETARY_INTERACTION.md section 5.
 */

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
  /** Extractor program length this character runs, in hours (default: params.programHours). */
  programHours?: number;
}

export interface OptimizeParams {
  /** P0 per hour one 10-head extractor gives on a resource that scans 100, on a one-day program. */
  yieldAtFull: number;
  /** Extractor program length in hours (default 24). Longer programs give less per hour and must store more. */
  programHours?: number;
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
  /** Haul and sell raw P0 the basic factories can't process (otherwise it piles up unused). */
  exportRawP0: boolean;
}

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
  /** The colony's layout, for pi_colony_calc. */
  layout?: Layout;
}

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

/** Static lookups the greedy loop makes thousands of times, cached per SDE. */
const lookups = new WeakMap<Sde, { tax: Map<number, number>; vol: Map<number, number>; name: Map<number, string> }>();
function cached(sde: Sde) {
  let l = lookups.get(sde);
  if (!l) lookups.set(sde, (l = { tax: new Map(), vol: new Map(), name: new Map() }));
  return l;
}
const memo = <V>(m: Map<number, V>, k: number, f: () => V) => {
  let v = m.get(k);
  if (v === undefined) m.set(k, (v = f()));
  return v;
};
const taxBase = (c: Ctx, type: number) => memo(cached(c.sde).tax, type, () => c.sde.attr(type, PI_ATTR.exportTaxBase) ?? 0);
const volume = (sde: Sde, type: number) => memo(cached(sde).vol, type, () => sde.type(type)?.volume ?? 0);
const typeName = (sde: Sde, type: number) => memo(cached(sde).name, type, () => sde.typeName(type));
const saleValue = (c: Ctx, type: number, perHour: number) => {
  const p = c.prices.get(type)?.sell;
  if (!p) return null;
  return perHour * (p * (1 - c.params.sellFee) - taxBase(c, type) * c.params.taxRate);
};

/**
 * Best extraction colony on a planet for two extractors on resources r1 and r2 (may be the same resource). Strong
 * deposits give more P0 than a command center can power basic factories for, so every head count is tried with as
 * many basic factories as still fit. Unprocessed P0 is exported raw only when asked (otherwise it piles up). Output
 * is sold as P1 or combined into P2, whichever pays more. Costs and production come from the shared layout model.
 */
export function extractionColony(
  c: Ctx, planet: PlanetInput, r1: number, r2: number, ccLevel: number, programHours = c.params.programHours ?? 24,
): Colony | null {
  const { costs, pi, params } = c;
  const factor = programFactor(programHours);
  const p1a = p1From(pi, r1);
  const p1b = p1From(pi, r2);
  if (!p1a || !p1b) return null;
  const p2 = r1 === r2 ? undefined : p2From(pi, p1a, p1b);
  const ab = (r: number) => planet.abundance.get(r) ?? 0;
  let best: Colony | null = null;
  let bestHeads = Infinity;
  for (let heads = MAX_HEADS; heads >= 1; heads--) {
    const extractors = [r1, r2].map((r) => ({ resource: r, heads, perHour: params.yieldAtFull * factor * (ab(r) / 100) * (heads / MAX_HEADS) }));
    const rate = new Map<number, number>();
    for (const e of extractors) rate.set(e.resource, (rate.get(e.resource) ?? 0) + e.perHour);
    const need = new Map([...rate].map(([r, v]) => [r, Math.max(1, Math.ceil(v / BASIC_P0_PER_HOUR - 1e-9))]));
    for (let adv = 0; adv <= (p2 ? 4 : 0); adv++) {
      let storage = 0;
      const layout = (alloc: Map<number, number>): Layout => ({
        ccLevel, extractors, storage, launchpads: 1,
        factories: [
          ...[...alloc].map(([r, n]) => ({ product: p1From(pi, r)!, count: n })),
          ...(adv ? [{ product: p2!, count: adv }] : []),
        ],
      });
      // As many basic factories as fit, one per resource first, then to whichever has the most unprocessed P0.
      const alloc = new Map([...rate.keys()].map((r) => [r, 1]));
      if (!layoutFits(costs, pi, layout(alloc))) continue;
      for (;;) {
        const next = [...rate].filter(([r]) => alloc.get(r)! < need.get(r)!)
          .sort((x, y) => (y[1] - alloc.get(y[0])! * BASIC_P0_PER_HOUR) - (x[1] - alloc.get(x[0])! * BASIC_P0_PER_HOUR))[0];
        if (!next) break;
        alloc.set(next[0], alloc.get(next[0])! + 1);
        if (!layoutFits(costs, pi, layout(alloc))) { alloc.set(next[0], alloc.get(next[0])! - 1); break; }
      }
      let l = layout(alloc);
      let sim = simulate(pi, l);
      // Everything the colony makes between visits (one program) waits on the launchpad and in storage.
      const held = [...sim.leftover].reduce((m, [t, r]) => m + r * (c.sde.type(t)?.volume ?? 0), 0) * programHours;
      if (held > LAUNCHPAD_M3) {
        storage = Math.ceil((held - LAUNCHPAD_M3) / STORAGE_M3);
        l = layout(alloc);
        if (!layoutFits(costs, pi, l)) continue;
        sim = simulate(pi, l);
      }
      const outputs: Flow[] = [];
      const unprocessed: Flow[] = [];
      for (const [type, perHour] of sim.leftover) {
        if (pi.tier.get(type) !== 0) outputs.push({ type, perHour });
        else if (params.exportRawP0 && c.prices.get(type)?.sell) outputs.push({ type, perHour });
        else if (perHour > 1) unprocessed.push({ type, perHour });
      }
      const values = outputs.map((o) => saleValue(c, o.type, o.perHour));
      if (values.some((v) => v == null)) continue;
      const isk = values.reduce((a, v) => a! + v!, 0)!;
      const basics = [...alloc.values()].reduce((a, b) => a + b, 0);
      const res = r1 === r2 ? `2 x ${c.sde.typeName(r1)} (${ab(r1)})` : `${c.sde.typeName(r1)} (${ab(r1)}) + ${c.sde.typeName(r2)} (${ab(r2)})`;
      const fmt = (f: Flow) => `${c.sde.typeName(f.type)} ${Math.round(f.perHour * 24).toLocaleString("en-US")}/day`;
      const colony: Colony = {
        kind: "extraction", planet, ccLevel, iskPerHour: isk, capitalPerHour: 0, outputs, inputs: [],
        key: [r1, r2].sort().join("+"),
        describe: `extract ${res}, ${heads} heads per extractor, ${programLabel(programHours)} programs, ` +
          `${basics} basic${adv ? ` + ${adv} advanced` : ""}${storage ? ` + ${storage} storage` : ""} -> ` +
          outputs.map((o) => `${fmt(o)} (${tierName(pi.tier.get(o.type))})`).join(", ") +
          (unprocessed.length ? ` (${unprocessed.map(fmt).join(", ")} unprocessed)` : ""),
        layout: l,
      };
      // Prefer fewer heads when it barely matters: cheaper, and less P0 left unprocessed.
      if (!best || colony.iskPerHour > best.iskPerHour * 1.005 || (colony.iskPerHour >= best.iskPerHour * 0.995 && heads < bestHeads)) {
        best = colony;
        bestHeads = heads;
      }
    }
  }
  return best;
}

/** "1-day" / "12-hour" with the cycle length, for colony descriptions. */
export function programLabel(hours: number): string {
  const len = hours % 24 === 0 ? `${hours / 24}-day` : `${hours}-hour`;
  const cyc = programCycleSeconds(hours) / 60;
  return `${len} (${cyc >= 60 ? `${cyc / 60} h` : `${cyc} min`} cycles)`;
}

/** How many factories of a product fit a command center next to a launchpad and one storage facility. */
export function factoriesThatFit(c: Ctx, product: number, ccLevel: number): number {
  let n = 0;
  while (layoutFits(c.costs, c.pi, { ccLevel, extractors: [], storage: 1, launchpads: 1, factories: [{ product, count: n + 1 }] })) n++;
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
  /** What the local search changed, when it improved on the greedy plan. */
  search?: string;
}

/** Extraction candidates per (CC level, program length), computed once and shared by every greedy run. */
export interface Prep {
  extraction: Map<string, Colony[]>;
  bestByPlanet: Map<string, Colony[]>;
  /** factoriesThatFit by "product|ccLevel". */
  fit: Map<string, number>;
}

const hoursOf = (s: Slot, params: OptimizeParams) => s.programHours ?? params.programHours ?? 24;
const variantOf = (s: Slot, params: OptimizeParams) => `${Math.min(s.ccLevel, 5)}|${hoursOf(s, params)}`;

export function prepare(sde: Sde, pi: PiData, costs: PinCosts, prices: Map<number, Price>, planets: PlanetInput[], slots: Slot[], params: OptimizeParams): Prep {
  const c: Ctx = { sde, pi, costs, prices, params };
  const variants = new Map(slots.map((s) => [variantOf(s, params), { lvl: Math.min(s.ccLevel, 5), hours: hoursOf(s, params) }]));
  const extraction = new Map<string, Colony[]>();
  const bestByPlanet = new Map<string, Colony[]>();
  let bestVariant: string | null = null;
  for (const [key, v] of variants) {
    const list: Colony[] = [];
    for (const planet of planets) {
      const res = [...planet.abundance.keys()];
      for (let i = 0; i < res.length; i++) for (let j = i; j < res.length; j++) {
        const col = extractionColony(c, planet, res[i], res[j], v.lvl, v.hours);
        if (col && col.iskPerHour > 0) list.push(col);
      }
    }
    list.sort((a, b) => b.iskPerHour - a.iskPerHour);
    extraction.set(key, list);
    const cur = bestVariant ? variants.get(bestVariant)! : null;
    if (!cur || v.lvl > cur.lvl || (v.lvl === cur.lvl && v.hours < cur.hours)) bestVariant = key;
  }
  for (const planet of planets) {
    bestByPlanet.set(planet.name, (extraction.get(bestVariant!) ?? []).filter((x) => x.planet.id === planet.id).slice(0, 3));
  }
  return { extraction, bestByPlanet, fit: new Map() };
}

/** Identifies a colony choice for the local search: a resource pair on a planet, or a factory product. */
export const choiceId = (col: Colony) => (col.kind === "extraction" ? `x:${col.planet.id}:${col.key}` : `f:${col.product}`);

export const planTotal = (p: Plan) => p.assignments.flatMap((a) => a.colonies).reduce((s, c) => s + c.iskPerHour, 0);

/**
 * Plans with two greedy orders and keeps the better total: by ISK/day, and by ISK/day per share of the scarce budgets
 * (haul m3 and input ISK). The first wins when budgets are loose; the second when one big colony would use up the haul
 * or input budget that many smaller colonies could have used better. Then a local search: drop one chosen colony
 * (ban that choice) and re-plan; keep the result when the total improves, until no single ban helps.
 */
export function optimize(
  sde: Sde, pi: PiData, costs: PinCosts, prices: Map<number, Price>, planets: PlanetInput[], slots: Slot[], params: OptimizeParams,
  opts: { maxReplans?: number } = {},
): Plan {
  const prep = prepare(sde, pi, costs, prices, planets, slots, params);
  const run = (mode: "value" | "density", banned: Set<string>) => optimizeOnce(sde, pi, costs, prices, planets, slots, params, mode, prep, banned);
  const starts = (["value", "density"] as const).map((mode) => ({ mode, plan: run(mode, new Set()) }));
  let best = planTotal(starts[1].plan) > planTotal(starts[0].plan) * 1.001 ? starts[1] : starts[0];
  let banned = new Set<string>();
  let budget = opts.maxReplans ?? 80;
  const start = planTotal(best.plan);
  for (let improved = true; improved && budget > 0;) {
    improved = false;
    const ids = [...new Set(best.plan.assignments.flatMap((a) => a.colonies).map(choiceId))].filter((id) => !banned.has(id));
    for (const id of ids) {
      if (budget-- <= 0) break;
      const tryBans = new Set([...banned, id]);
      const plan = run(best.mode, tryBans);
      if (planTotal(plan) > planTotal(best.plan) * 1.002) {
        best = { mode: best.mode, plan };
        banned = tryBans;
        improved = true;
        break;
      }
    }
  }
  const gain = planTotal(best.plan) - start;
  if (gain > 0) {
    best.plan.search = `local search added ${Math.round((gain / Math.max(1, start)) * 100)}% by leaving out ` +
      [...banned].map((b) => describeChoice(sde, planets, b)).join(", ");
  }
  return best.plan;
}

function describeChoice(sde: Sde, planets: PlanetInput[], id: string): string {
  const [kind, a, b] = id.split(":");
  if (kind === "f") return `${sde.typeName(Number(a))} factories`;
  const planet = planets.find((p) => p.id === Number(a));
  return `${b.split("+").map((r) => sde.typeName(Number(r))).join(" + ")} on ${planet?.name ?? a}`;
}

export function optimizeOnce(
  sde: Sde, pi: PiData, costs: PinCosts, prices: Map<number, Price>, planets: PlanetInput[], slots: Slot[], params: OptimizeParams,
  mode: "value" | "density", prep = prepare(sde, pi, costs, prices, planets, slots, params), banned: Set<string> = new Set(),
): Plan {
  const c: Ctx = { sde, pi, costs, prices, params };
  const warnings: string[] = [];
  const { extraction, bestByPlanet } = prep;
  const variant = (s: Slot) => variantOf(s, params);

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

  const vol = (type: number) => volume(sde, type);
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

  /** How the greedy loop ranks a candidate colony. */
  const score = (col: Colony & { haul?: number }) => {
    if (mode === "value") return col.iskPerHour;
    const haul = col.kind === "extraction" ? m3(col.outputs) : Math.max(0, col.haul ?? 0);
    const haulShare = params.maxHaulPerDay > 0 ? haul / params.maxHaulPerDay : 0;
    const capitalShare = params.maxCapitalPerDay > 0 ? (col.capitalPerHour * 24) / params.maxCapitalPerDay : 0;
    return col.iskPerHour / (0.02 + haulShare + capitalShare);
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
    const fmt = (f: Flow) => `${typeName(sde, f.type)} ${Math.round(f.perHour * 24).toLocaleString("en-US")}/day`;
    const parts = [
      local.length ? `your colonies' ${local.map(fmt).join(", ")}` : "",
      bought.length ? `bought ${bought.map(fmt).join(", ")}` : "",
    ].filter(Boolean).join(" + ");
    return {
      kind: "factory", planet, ccLevel: lvl, iskPerHour: isk, capitalPerHour: capital,
      outputs: [{ type: product, perHour: outPerHour }], inputs: bought, poolUse: local, haul,
      describe: `factory: ${n} x ${pi.factoryName.get(pi.tier.get(product)!)} making ${typeName(sde, product)} from ${parts} ` +
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
    let pick: { slot: Slot; colony: Colony & { haul?: number; poolUse?: Flow[] }; score: number } | null = null;
    for (const slot of slots) {
      if (!free.get(slot.character)) continue;
      const mine = onPlanet.get(slot.character)!;
      const lvl = Math.min(slot.ccLevel, 5);
      for (const ex of extraction.get(variant(slot)) ?? []) {
        if (mine.has(ex.planet.id) || m3(ex.outputs) > haulLeft) continue;
        if ((extractorsOn.get(ex.planet.id) ?? 0) >= params.maxCharactersPerPlanet) continue;
        // The same resources twice on one planet would compete for the same deposits.
        if (taken.has(`${ex.planet.id}:${ex.key}`) || banned.has(choiceId(ex))) continue;
        const sc = score(ex);
        if (!pick || sc > pick.score) pick = { slot, colony: ex, score: sc };
      }
      for (const product of products) {
        if (banned.has(`f:${product}`)) continue;
        const where = (pi.tier.get(product) === 4 ? highTechPlanets : planets).find((p) => !mine.has(p.id));
        if (!where) continue;
        // Try every factory count that fits the command center; keep the most valuable.
        const fk = `${product}|${lvl}`;
        if (!prep.fit.has(fk)) prep.fit.set(fk, factoriesThatFit(c, product, lvl));
        for (let n = prep.fit.get(fk)!; n >= 1; n--) {
          const col = factoryColony(product, n, where, lvl);
          if (!col || col.iskPerHour <= 0) continue;
          const sc = score(col);
          if (!pick || sc > pick.score) pick = { slot, colony: col, score: sc };
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
