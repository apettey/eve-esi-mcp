import type { Sde } from "./sde/db.js";
import { perHour, type PiData } from "./pi.js";
import { LAUNCHPAD_M3, STORAGE_M3 } from "./pi-optimize.js";

/**
 * Reading a PI colony from its ESI layout: extractor output over the program (with the decay curve), what each factory
 * needs and makes per hour, the planet's input/output balance, and how long until storage is full. Research notes:
 * docs/PLANETARY_INTERACTION.md section 1 ("Extractor output").
 */

export const COMMAND_CENTER_M3 = 500;
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

  for (const pin of pins) {
    const group = sde.type(pin.type_id)?.group_id;
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
      if (ex.product_type_id && program && expiryMs! > nowMs) bump(made, ex.product_type_id, program.nowPerHour);
      continue;
    }

    const sid = pin.schematic_id ?? pin.factory_details?.schematic_id;
    if (!sid) continue;
    const out = [...pi.schematic.values()].find((s) => s.id === sid);
    if (!out) continue;
    bump(factories, out.output, 1);
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
  // Factories that are short of input don't make their full output; scale their output by the worst input coverage.
  for (const [product, count] of factories) {
    const s = pi.schematic.get(product)!;
    const cover = Math.min(1, ...s.inputs.map(([i]) => {
      const need = used.get(i) ?? 0;
      return need ? (made.get(i) ?? 0) / need : 1;
    }));
    if (cover < 1) made.set(product, (made.get(product) ?? 0) - perHour(pi, product) * count * (1 - cover));
  }
  let surplusM3PerHour = 0;
  for (const [type, rate] of made) {
    const left = rate - Math.min(rate, used.get(type) ?? 0);
    surplusM3PerHour += left * (sde.type(type)?.volume ?? 0);
  }
  return { extractors, factories, idleFactories, made, used, shortfalls, storedM3, capacityM3, surplusM3PerHour, contents };
}

/**
 * P0 per hour that a 10-head extractor would give on a resource scanning 100, from one real extractor: its average
 * output over the program, scaled to 10 heads and to a reading of 100. Matches pi_optimize's yield model.
 */
export function yieldAt100(ex: ColonyExtractor, reading: number): number | null {
  if (!ex.program || !ex.heads || reading <= 0) return null;
  return ex.program.avgPerHour * (10 / ex.heads) / (reading / 100);
}
