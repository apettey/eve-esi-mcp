import type { Sde } from "./sde/db.js";
import { perHour, type PiData } from "./pi.js";
import { COMMAND_CENTER_M3, LAUNCHPAD_M3, STORAGE_M3 } from "./pi-layout.js";

/**
 * Reading a PI colony from its ESI layout: extractor output over the program (with the decay curve), what each factory
 * needs and makes per hour, the planet's input/output balance, and how long until storage is full. Research notes:
 * docs/PLANETARY_INTERACTION.md section 1 ("Extractor output").
 */


const GROUP = { commandCenter: 1027, storage: 1029, launchpad: 1030 } as const;

/**
 * Units one extractor cycle gives. Community reverse-engineered curve (used by the major PI planners): output decays
 * over the program and wobbles with a deterministic noise term. `base` is ESI's `qty_per_cycle`.
 */
export function cycleOutput(base: number, cycleIndex: number, cycleSeconds: number): number {
  const barWidth = cycleSeconds / 900;
  const t = (cycleIndex + 0.5) * barWidth;
  const decay = base / (1 + t * 0.012);
  const phase = base ** 0.7;
  const noise = Math.max((Math.cos(phase + t / 12) + Math.cos(phase / 2 + t * 0.2) + Math.cos(t * 0.5)) / 3, 0);
  return Math.floor(barWidth * decay * (1 + 0.8 * noise));
}

/**
 * Cycle length for an extractor program of `hours`. Observed live: 15 minutes on one-day programs. Longer programs are
 * assumed to double the cycle with each doubling of length (2 days: 30 min, 3-4 days: 1 h, 5-8 days: 2 h, up to 14
 * days: 4 h). Unverified beyond one day: see docs/PLANETARY_INTERACTION.md section 1.
 */
export function programCycleSeconds(hours: number): number {
  return 900 * 2 ** Math.max(0, Math.ceil(Math.log2(hours / 24) - 1e-9));
}

/** Mean decay over a program of `hours` (decay term of the curve only; the noise term averages out). */
function meanDecay(hours: number): number {
  const cycle = programCycleSeconds(hours);
  const cycles = Math.max(1, Math.round((hours * 3600) / cycle));
  const bar = cycle / 900;
  let sum = 0;
  for (let i = 0; i < cycles; i++) sum += 1 / (1 + (i + 0.5) * bar * 0.012);
  return sum / cycles;
}

/**
 * Output per hour of a program of `hours` relative to a one-day program at the same spot (same qty_per_cycle). Per
 * hour the curve gives 4 x qty_per_cycle x decay(t), whatever the cycle length, so longer programs only lose to decay.
 */
export function programFactor(hours: number): number {
  return meanDecay(hours) / meanDecay(24);
}

export interface ExtractorProgram {
  cycles: number;
  total: number;
  avgPerHour: number;
  nowPerHour: number;
  remaining: number;
  done: number;
}

/** Totals for a whole extractor program from install to expiry, and the current rate. */
export function extractorProgram(base: number, cycleSeconds: number, installMs: number, expiryMs: number, nowMs: number): ExtractorProgram {
  const cycles = Math.max(0, Math.round((expiryMs - installMs) / 1000 / cycleSeconds));
  const elapsed = Math.max(0, Math.min(cycles, Math.floor((nowMs - installMs) / 1000 / cycleSeconds)));
  let total = 0;
  let done = 0;
  for (let i = 0; i < cycles; i++) {
    const out = cycleOutput(base, i, cycleSeconds);
    total += out;
    if (i < elapsed) done += out;
  }
  const hours = (cycles * cycleSeconds) / 3600;
  const current = elapsed < cycles ? cycleOutput(base, elapsed, cycleSeconds) : 0;
  return {
    cycles, total, done, remaining: total - done,
    avgPerHour: hours ? total / hours : 0,
    nowPerHour: current * (3600 / cycleSeconds),
  };
}

export interface ColonyExtractor {
  product: number;
  heads: number;
  cycleSeconds: number;
  qtyPerCycle: number;
  installMs: number | null;
  expiryMs: number | null;
  program: ExtractorProgram | null;
}

export interface ColonyAnalysis {
  extractors: ColonyExtractor[];
  /** Schematic output -> number of factories. */
  factories: Map<number, number>;
  /** Factories whose last cycle started more than two cycles ago: no inputs. */
  idleFactories: Map<number, number>;
  /** Units per hour made (extractors now, factories at full speed) and consumed (factories at full speed). */
  made: Map<number, number>;
  used: Map<number, number>;
  /** For each factory input: share of demand covered by what the planet makes (0..1), when short. */
  shortfalls: Array<{ type: number; need: number; have: number }>;
  /** m3 stored and capacity across storage, launchpads and the command center. */
  storedM3: number;
  capacityM3: number;
  /** m3 per hour that piles up (made but not used on the planet), at current extractor rates. */
  surplusM3PerHour: number;
  contents: Map<number, number>;
  /** Factory inputs that no route brings to the factory: those factories can't run. */
  unroutedInputs: Array<{ product: number; input: number; factories: number }>;
  /** Extractor or factory output that no route carries away. */
  unroutedOutputs: Array<{ type: number; from: "extractor" | "factory"; pins: number }>;
  /** Factories fed straight from another extractor or factory (not via storage) that get less than they need. */
  routeShortfalls: Array<{ product: number; input: number; factories: number; need: number; have: number }>;
}

export function analyzeColony(sde: Sde, pi: PiData, layout: any, nowMs: number): ColonyAnalysis {
  const pins: any[] = layout?.pins ?? [];
  const extractors: ColonyExtractor[] = [];
  const factories = new Map<number, number>();
  const idleFactories = new Map<number, number>();
  const made = new Map<number, number>();
  const used = new Map<number, number>();
  const contents = new Map<number, number>();
  const bump = (m: Map<number, number>, k: number, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  let storedM3 = 0;
  let capacityM3 = 0;
  const kind = new Map<number, "extractor" | "factory" | "store">();
  /** Output per hour of each extractor (now) and factory (full speed, before input shortages). */
  const rateOut = new Map<number, number>();
  const factoryPins: Array<{ pin: number; product: number }> = [];
  const extractorPins: Array<{ pin: number; product: number }> = [];

  for (const pin of pins) {
    const group = sde.type(pin.type_id)?.group_id;
    if (group === GROUP.launchpad || group === GROUP.storage || group === GROUP.commandCenter) kind.set(pin.pin_id, "store");
    if (group === GROUP.launchpad) capacityM3 += LAUNCHPAD_M3;
    else if (group === GROUP.storage) capacityM3 += STORAGE_M3;
    else if (group === GROUP.commandCenter) capacityM3 += COMMAND_CENTER_M3;
    for (const c of pin.contents ?? []) {
      bump(contents, c.type_id, c.amount);
      if (group === GROUP.launchpad || group === GROUP.storage || group === GROUP.commandCenter) {
        storedM3 += (sde.type(c.type_id)?.volume ?? 0) * c.amount;
      }
    }

    const ex = pin.extractor_details;
    if (ex) {
      const installMs = pin.install_time ? Date.parse(pin.install_time) : null;
      const expiryMs = pin.expiry_time ? Date.parse(pin.expiry_time) : null;
      const cycleSeconds = ex.cycle_time ?? 0;
      const qty = ex.qty_per_cycle ?? 0;
      const program = installMs != null && expiryMs != null && cycleSeconds > 0 && qty > 0
        ? extractorProgram(qty, cycleSeconds, installMs, expiryMs, nowMs)
        : null;
      extractors.push({ product: ex.product_type_id, heads: ex.heads?.length ?? 0, cycleSeconds, qtyPerCycle: qty, installMs, expiryMs, program });
      const running = !!(ex.product_type_id && program && expiryMs! > nowMs);
      if (running) bump(made, ex.product_type_id, program!.nowPerHour);
      kind.set(pin.pin_id, "extractor");
      rateOut.set(pin.pin_id, running ? program!.nowPerHour : 0);
      if (running) extractorPins.push({ pin: pin.pin_id, product: ex.product_type_id });
      continue;
    }

    const sid = pin.schematic_id ?? pin.factory_details?.schematic_id;
    if (!sid) continue;
    const out = [...pi.schematic.values()].find((s) => s.id === sid);
    if (!out) continue;
    bump(factories, out.output, 1);
    kind.set(pin.pin_id, "factory");
    factoryPins.push({ pin: pin.pin_id, product: out.output });
    const last = pin.last_cycle_start ? Date.parse(pin.last_cycle_start) : null;
    if (last == null || nowMs - last > 2 * out.cycle * 1000) bump(idleFactories, out.output, 1);
    bump(made, out.output, perHour(pi, out.output));
    for (const [i, q] of out.inputs) bump(used, i, (q * 3600) / out.cycle);
  }

  const shortfalls: ColonyAnalysis["shortfalls"] = [];
  for (const [type, need] of used) {
    const have = made.get(type) ?? 0;
    if (have < need * 0.98) shortfalls.push({ type, need, have });
  }
  // Factories that are short of input don't make their full output. Each factory pin runs at the share its scarcest
  // input allows: 0 when no route brings an input; the routed share of the source's output when it is fed straight
  // from an extractor or factory; the planet-wide balance when it is fed from storage (or when ESI gave no routes).
  const routes: any[] | null = Array.isArray(layout?.routes) ? layout.routes : null;
  const planetCover = (i: number) => {
    const need = used.get(i) ?? 0;
    return need ? Math.min(1, (made.get(i) ?? 0) / need) : 1;
  };
  const unrouted = new Map<string, { product: number; input: number; factories: number }>();
  const routeShort = new Map<string, { product: number; input: number; factories: number; need: number; have: number }>();
  const ordered = [...factoryPins].sort((x, y) => (pi.tier.get(x.product) ?? 0) - (pi.tier.get(y.product) ?? 0));
  const fullRate = new Map<number, number>();
  for (const f of ordered) fullRate.set(f.pin, perHour(pi, f.product));
  for (const f of ordered) {
    const s = pi.schematic.get(f.product)!;
    let cover = 1;
    for (const [i, q] of s.inputs) {
      const need = (q * 3600) / s.cycle;
      if (!routes) { cover = Math.min(cover, planetCover(i)); continue; }
      const ins = routes.filter((r) => r.destination_pin_id === f.pin && r.content_type_id === i);
      const key = `${f.product}:${i}`;
      if (!ins.length) {
        const u = unrouted.get(key) ?? { product: f.product, input: i, factories: 0 };
        u.factories++;
        unrouted.set(key, u);
        cover = 0;
        continue;
      }
      if (ins.some((r) => kind.get(r.source_pin_id) !== "extractor" && kind.get(r.source_pin_id) !== "factory")) {
        cover = Math.min(cover, planetCover(i));
        continue;
      }
      let have = 0;
      for (const r of ins) {
        const outs = routes.filter((o) => o.source_pin_id === r.source_pin_id && o.content_type_id === i);
        const total = outs.reduce((t, o) => t + (o.quantity || 1), 0);
        have += ((rateOut.get(r.source_pin_id) ?? 0) * (r.quantity || 1)) / total;
      }
      if (have < need * 0.98) {
        const rs = routeShort.get(key) ?? { product: f.product, input: i, factories: 0, need: 0, have: 0 };
        rs.factories++;
        rs.need += need;
        rs.have += have;
        routeShort.set(key, rs);
      }
      cover = Math.min(cover, have / need);
    }
    rateOut.set(f.pin, fullRate.get(f.pin)! * cover);
    if (cover < 1) made.set(f.product, (made.get(f.product) ?? 0) - fullRate.get(f.pin)! * (1 - cover));
  }

  const unroutedOutputs: ColonyAnalysis["unroutedOutputs"] = [];
  if (routes) {
    const notOut = (pins: Array<{ pin: number; product: number }>, from: "extractor" | "factory") => {
      const byType = new Map<number, number>();
      for (const p of pins) {
        if (!routes.some((r) => r.source_pin_id === p.pin && r.content_type_id === p.product)) byType.set(p.product, (byType.get(p.product) ?? 0) + 1);
      }
      for (const [type, n] of byType) unroutedOutputs.push({ type, from, pins: n });
    };
    notOut(extractorPins, "extractor");
    notOut(factoryPins, "factory");
  }
  let surplusM3PerHour = 0;
  for (const [type, rate] of made) {
    const left = rate - Math.min(rate, used.get(type) ?? 0);
    surplusM3PerHour += left * (sde.type(type)?.volume ?? 0);
  }
  return {
    extractors, factories, idleFactories, made, used, shortfalls, storedM3, capacityM3, surplusM3PerHour, contents,
    unroutedInputs: [...unrouted.values()], unroutedOutputs, routeShortfalls: [...routeShort.values()],
  };
}

/** Program length in hours, from install to expiry. */
export function programHours(ex: ColonyExtractor): number | null {
  return ex.installMs != null && ex.expiryMs != null && ex.expiryMs > ex.installMs ? (ex.expiryMs - ex.installMs) / 3_600_000 : null;
}

/**
 * P0 per hour that a 10-head extractor would give on a resource scanning 100 on a one-day program, from one real
 * extractor: its average output over its own program, scaled to 10 heads, to a reading of 100 and from its program
 * length to one day. Matches pi_optimize's yield model.
 */
export function yieldAt100(ex: ColonyExtractor, reading: number): number | null {
  if (!ex.program || !ex.heads || reading <= 0) return null;
  const hours = programHours(ex);
  return ex.program.avgPerHour * (10 / ex.heads) / (reading / 100) / (hours ? programFactor(hours) : 1);
}
