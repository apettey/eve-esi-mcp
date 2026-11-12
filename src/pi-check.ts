import type { Sde } from "./sde/db.js";
import type { PiData } from "./pi.js";
import { analyzeColony, programHours } from "./pi-colony.js";
import type { PlanColony, SavedPlan } from "./pi-plan.js";
import { duration } from "./util.js";

/**
 * Compares what characters have built with a saved plan: per planned colony, whether it exists, its command center
 * level, extractors (resource, heads, program running and its length), factories (schematic and count), routing, and
 * for factory colonies the inputs on hand. Pure: the caller fetches the colonies from ESI.
 */

/** One character's colonies as ESI gave them: the /planets list and each colony's layout by planet id. */
export interface ActualColonies {
  planets: Array<{ planet_id: number; planet_type: string; solar_system_id: number; upgrade_level: number; last_update?: string }>;
  layouts: Map<number, any>;
}

export interface ColonyCheck {
  planet: string;
  ok: boolean;
  /** "VI (Barren): ok (...)" or "VI (Barren): issue; issue" */
  line: string;
  issues: string[];
}

export interface CharacterCheck {
  character: string;
  ok: boolean;
  built: number;
  planned: number;
  colonies: ColonyCheck[];
  /** Colonies in the plan's system that the plan doesn't have for this character. */
  extra: string[];
  /** Oldest last_update of the planned colonies: ESI only refreshes a colony when it is opened in game. */
  oldestUpdateMs?: number;
  unavailable?: string;
}

const n0 = (n: number) => Math.round(n).toLocaleString("en-US");
const short = (name: string) => name.split(" ").pop()!;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function checkColony(sde: Sde, pi: PiData, plan: SavedPlan, c: PlanColony, layout: any | null, ccLevel: number | null, nowMs: number): ColonyCheck {
  const where = `${short(c.planet.name)} (${c.planet.type})`;
  const done = (issues: string[], summary: string): ColonyCheck =>
    ({ planet: c.planet.name, ok: !issues.length, issues, line: issues.length ? `${where}: ${issues.join("; ")}` : `${where}: ok (${summary})` });
  if (!layout) return done(["not built yet"], "");

  const issues: string[] = [];
  const name = (t: number) => sde.typeName(t);
  if (ccLevel != null && ccLevel < c.layout.ccLevel) issues.push(`command center level ${ccLevel}, plan ${c.layout.ccLevel}`);
  const a = analyzeColony(sde, pi, layout, nowMs);

  // Extractors: compare per resource (total heads, number of extractors); the split between two extractors on the
  // same resource doesn't matter.
  const want = new Map<number, { heads: number; count: number }>();
  for (const e of c.layout.extractors) {
    const w = want.get(e.resource) ?? { heads: 0, count: 0 };
    w.heads += e.heads;
    w.count++;
    want.set(e.resource, w);
  }
  const have = new Map<number, typeof a.extractors>();
  for (const e of a.extractors) {
    if (!e.product) { issues.push("an extractor has no program set"); continue; }
    have.set(e.product, [...(have.get(e.product) ?? []), e]);
  }
  const headParts: string[] = [];
  // Extra heads only matter when they take the CPU/PG the planned factories need (every head costs 550 MW).
  const factoriesShort = c.layout.factories.some((f) => (a.factories.get(f.product) ?? 0) < f.count);
  for (const [res, w] of want) {
    const got = have.get(res) ?? [];
    const heads = sum(got.map((e) => e.heads));
    if (!got.length) { issues.push(`no ${name(res)} extractor`); continue; }
    if (got.length < w.count) issues.push(`${got.length} of ${w.count} ${name(res)} extractors`);
    if (heads < w.heads) issues.push(`${name(res)} ${heads} of ${w.heads} heads`);
    if (heads > w.heads && factoriesShort) issues.push(`${name(res)} ${heads} heads, plan ${w.heads}: remove ${heads - w.heads} so the factories fit`);
    headParts.push(`${name(res)} ${heads}`);
  }
  for (const [res, got] of have) if (!want.has(res)) issues.push(`extracts ${name(res)} (${got.length}), not in the plan`);
  let soonest: number | null = null;
  for (const e of a.extractors) {
    if (!e.product) continue;
    if (e.expiryMs == null) { issues.push(`${name(e.product)} program not started`); continue; }
    if (e.expiryMs <= nowMs) { issues.push(`${name(e.product)} program ended ${duration(nowMs - e.expiryMs)} ago`); continue; }
    soonest = Math.min(soonest ?? Infinity, e.expiryMs);
    const h = programHours(e);
    if (h != null && Math.abs(h - c.programHours) > 1) issues.push(`${name(e.product)} program ${Math.round(h)} h, plan ${c.programHours} h`);
  }

  // Factories by product.
  const plannedF = new Map(c.layout.factories.map((f) => [f.product, f.count]));
  const factoryParts: string[] = [];
  for (const [product, count] of plannedF) {
    const got = a.factories.get(product) ?? 0;
    if (got < count) issues.push(`${got} of ${count} ${name(product)} factories`);
    if (got) factoryParts.push(`${name(product)} ×${got}`);
  }
  for (const [product, got] of a.factories) if (!plannedF.has(product)) issues.push(`${got} ${name(product)} factories, not in the plan`);

  // Routing.
  for (const u of a.unroutedInputs) issues.push(`no route brings ${name(u.input)} to ${u.factories} ${name(u.product)} factor${u.factories === 1 ? "y" : "ies"}`);
  for (const u of a.unroutedOutputs) issues.push(`${name(u.type)} from ${u.pins} ${u.from}${u.pins === 1 ? "" : "s"} isn't routed anywhere`);
  for (const s of a.routeShortfalls) issues.push(`${name(s.product)} factories fed ${name(s.input)} directly get ${n0(s.have)} of ${n0(s.need)}/h`);

  // Factory colonies run on goods brought in: what is on hand, and idle factories.
  // Less than a day of any input on hand (or factories already idle) means: bring the restock.
  const stock: string[] = [];
  if (c.kind === "factory") {
    let low = false;
    for (const [input, perHour] of a.used) {
      const onHand = a.contents.get(input) ?? 0;
      const days = onHand / (perHour * 24);
      if (days < 1) low = true;
      stock.push(`${name(input)} ${n0(onHand)} (${days < 0.05 ? "none" : `${days.toFixed(1)} days`})`);
    }
    const idle = sum([...a.idleFactories.values()]);
    if (idle || low) {
      const needs = [...a.used].map(([i, h]) => `${name(i)} ${n0(h * 24 * plan.restockDays)}`).join(" + ");
      const state = idle ? `${idle} factor${idle === 1 ? "y" : "ies"} idle` : `inputs for under a day (on hand: ${stock.join(", ")})`;
      issues.push(`${state}: bring ${needs} (${plan.restockDays} days)`);
    }
  }

  const summary = [
    headParts.length ? `${headParts.join(" + ")} heads` : "",
    factoryParts.join(" + "),
    stock.length ? `on hand: ${stock.join(", ")}` : "",
    soonest != null ? `${duration(soonest - nowMs)} left` : "",
  ].filter(Boolean).join("; ");
  return done(issues, summary);
}

/** Checks every character in the plan (or those in `actual` only, when it holds a subset). */
export function checkPlan(
  sde: Sde, pi: PiData, plan: SavedPlan, actual: Map<string, ActualColonies | Error>, nowMs: number,
): CharacterCheck[] {
  const out: CharacterCheck[] = [];
  for (const [character, got] of actual) {
    const planned = plan.colonies.filter((c) => c.character.toLowerCase() === character.toLowerCase());
    if (got instanceof Error) {
      out.push({ character, ok: false, built: 0, planned: planned.length, colonies: [], extra: [], unavailable: got.message });
      continue;
    }
    const byPlanet = new Map(got.planets.map((p) => [p.planet_id, p]));
    const colonies = planned
      .slice()
      .sort((x, y) => x.planet.name.localeCompare(y.planet.name, "en", { numeric: true }))
      .map((c) => checkColony(sde, pi, plan, c, got.layouts.get(c.planet.id) ?? null, byPlanet.get(c.planet.id)?.upgrade_level ?? null, nowMs));
    const plannedIds = new Set(planned.map((c) => c.planet.id));
    const extra = got.planets
      .filter((p) => p.solar_system_id === plan.system.id && !plannedIds.has(p.planet_id))
      .map((p) => `${short(sde.planetName(p.planet_id) ?? String(p.planet_id))} (${p.planet_type})`);
    const updates = got.planets.filter((p) => plannedIds.has(p.planet_id) && p.last_update).map((p) => Date.parse(p.last_update!));
    out.push({
      character,
      ok: colonies.every((x) => x.ok) && !extra.length,
      built: colonies.filter((x) => !x.issues.includes("not built yet")).length,
      planned: planned.length,
      colonies,
      extra,
      oldestUpdateMs: updates.length ? Math.min(...updates) : undefined,
    });
  }
  return out;
}
