import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Sde } from "./sde/db.js";
import { tierName, type PiData } from "./pi.js";
import { layoutFits, type Flow, type Layout, type PinCosts } from "./pi-layout.js";
import { programLabel, type Colony, type Plan, type Slot } from "./pi-optimize.js";
import { setupSteps } from "./pi-setup.js";
import { buildTemplate, templateFileName, type PiTemplate } from "./pi-template.js";
import { UserError } from "./util.js";

/**
 * Saved PI plans. pi_optimize prices everything live, so two runs can pick different colonies; a saved plan freezes the
 * chosen colonies (layouts included) so build sheets and colony templates come out the same every time until you
 * replan. Plans live as JSON in <data dir>/pi-plans. Everything derived here (sheets, templates, haul, markdown) is a
 * pure function of the saved plan and static data.
 */

export interface PlanColony {
  character: string;
  planet: { id: number; name: string; type: string };
  kind: "extraction" | "factory";
  describe: string;
  iskPerHour: number;
  capitalPerHour: number;
  programHours: number;
  layout: Layout;
  product?: number;
  outputs: Flow[];
  /** Factory colonies: bought inputs, and inputs from the plan's own colonies. */
  bought?: Flow[];
  local?: Flow[];
}

export interface SavedPlan {
  version: 1;
  name: string;
  savedAt: string;
  system: { id: number; name: string };
  market: string;
  restockDays: number;
  colonies: PlanColony[];
  /** Per hour: what the plan's colonies make and nothing in the plan uses (to haul out and sell). */
  exports: Flow[];
  totals: { iskPerDay: number; inputsPerDay: number; haulInM3PerDay: number; haulOutM3PerDay: number };
}

export function toSavedPlan(
  name: string, system: { id: number; name: string }, market: string, plan: Plan, slots: Slot[],
  params: { programHours: number; restockDays: number }, savedAt = new Date().toISOString(),
): SavedPlan {
  const colonies: PlanColony[] = plan.assignments.flatMap((x) => {
    const hours = slots.find((s) => s.character === x.character)?.programHours ?? params.programHours;
    return x.colonies.filter((c: Colony) => c.layout).map((c: Colony) => ({
      character: x.character,
      planet: { id: c.planet.id, name: c.planet.name, type: c.planet.type },
      kind: c.kind,
      describe: c.describe,
      iskPerHour: c.iskPerHour,
      capitalPerHour: c.capitalPerHour,
      programHours: hours,
      layout: c.layout!,
      product: c.product,
      outputs: c.outputs,
      bought: c.kind === "factory" ? c.inputs : undefined,
      local: c.kind === "factory" ? c.local ?? [] : undefined,
    }));
  });
  return {
    version: 1, name, savedAt, system, market, restockDays: params.restockDays, colonies, exports: plan.remainingLocal,
    totals: {
      iskPerDay: colonies.reduce((s, c) => s + c.iskPerHour * 24, 0),
      inputsPerDay: plan.totals.capitalPerDay,
      haulInM3PerDay: plan.totals.haulIn,
      haulOutM3PerDay: plan.totals.haulOut,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Derived output

const short = (planet: string) => planet.split(" ").pop()!;

/** The template / file name for a colony: "J123456 VI - Precious Metals (Main)". */
export function colonyName(sde: Sde, c: PlanColony): string {
  const what = c.kind === "factory" && c.product
    ? sde.typeName(c.product)
    : [...new Set(c.outputs.map((o) => sde.typeName(o.type)))].join(" + ") || "extraction";
  return `${c.planet.name} - ${what} (${c.character})`;
}

/** Where each good is made in the plan, so factory colonies know which colonies feed them. */
function makers(p: SavedPlan): Map<number, string[]> {
  const m = new Map<number, string[]>();
  for (const c of p.colonies) {
    for (const o of c.outputs) {
      const at = `${short(c.planet.name)} (${c.character})`;
      const list = m.get(o.type) ?? [];
      if (!list.includes(at)) list.push(at);
      m.set(o.type, list);
    }
  }
  return m;
}

export function colonySheet(sde: Sde, pi: PiData, p: SavedPlan, c: PlanColony, made = makers(p)): string[] {
  return setupSteps(sde, pi, {
    layout: c.layout, programHours: c.programHours, restockDays: p.restockDays,
    bought: c.kind === "factory" ? c.bought : undefined,
    local: c.kind === "factory" ? (c.local ?? []).map((f) => ({ ...f, from: made.get(f.type) })) : undefined,
  });
}

export interface ColonyTemplate {
  colony: PlanColony;
  name: string;
  /** Path under the template folder: one folder per character, "Planet VI.json" inside it. */
  file: string;
  template: PiTemplate;
  links: string;
  /** False when the template's real link lengths push the colony over its command center. */
  fits: boolean;
}

export function colonyTemplates(sde: Sde, pi: PiData, costs: PinCosts, p: SavedPlan, colonies = p.colonies): ColonyTemplate[] {
  return colonies.map((c) => {
    const name = colonyName(sde, c);
    const radius = sde.planetRadius(c.planet.id);
    const t = buildTemplate(sde, pi, {
      layout: c.layout, planetType: c.planet.type, name, programHours: c.programHours,
      diameterKm: radius ? (2 * radius) / 1000 : undefined,
    });
    return {
      colony: c, name, file: `${templateFileName(c.character).replace(/\.json$/, "")}/${templateFileName(`Planet ${c.planet.name.split(" ").pop()}`)}`,
      template: t.template,
      links: radius ? `${t.links.count} links, ${Math.round(t.links.totalKm)} km` : `${t.links.count} links`,
      fits: !radius || layoutFits(costs, pi, { ...c.layout, links: t.links }),
    };
  });
}

const n0 = (n: number) => Math.round(n).toLocaleString("en-US");

export interface Haul { every: string; buy: Array<[number, number]>; sell: Array<[number, number]>; m3In: number; m3Out: number; buyCost: number }

export function haulPerTrip(sde: Sde, p: SavedPlan): Haul {
  const days = p.restockDays;
  const vol = (t: number) => sde.type(t)?.volume ?? 0;
  const buy = new Map<number, number>();
  for (const c of p.colonies) for (const f of c.bought ?? []) buy.set(f.type, (buy.get(f.type) ?? 0) + f.perHour * 24 * days);
  const sell = p.exports.map((f) => [f.type, f.perHour * 24 * days] as [number, number]);
  return {
    every: `${days} days`, buy: [...buy], sell,
    m3In: [...buy].reduce((m, [t, n]) => m + vol(t) * n, 0),
    m3Out: sell.reduce((m, [t, n]) => m + vol(t) * n, 0),
    buyCost: p.totals.inputsPerDay * days,
  };
}

export const haulLine = (sde: Sde, [t, n]: [number, number]) =>
  `${sde.typeName(t)} x${n0(n)} (${n0((sde.type(t)?.volume ?? 0) * n)} m³)`;

const iskShort = (v: number) => v === 0 ? "none" : (Math.abs(v) >= 1e9 ? `${(v / 1e9).toFixed(2)}b` : Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(2)}m` : `${(v / 1e3).toFixed(2)}k`) + " ISK";

/** The whole plan as a markdown build book: overview, local supply, haul, then one build sheet per colony. */
export function planMarkdown(sde: Sde, pi: PiData, costs: PinCosts, p: SavedPlan): string {
  const made = makers(p);
  const templates = colonyTemplates(sde, pi, costs, p);
  const chars = [...new Set(p.colonies.map((c) => c.character))];
  const o: string[] = [];
  o.push(`# ${p.name}`, "");
  o.push(`${p.system.name}, saved ${p.savedAt.slice(0, 10)} with ${p.market} prices. **${iskShort(p.totals.iskPerDay)}/day** across ` +
    `${chars.length} characters: ${p.colonies.filter((c) => c.kind === "extraction").length} extraction and ` +
    `${p.colonies.filter((c) => c.kind === "factory").length} factory colonies. Inputs bought: ${p.totals.inputsPerDay ? `${iskShort(p.totals.inputsPerDay)}/day` : "none"}. ` +
    `Haul: ${n0(p.totals.haulInM3PerDay)} m³/day in, ${n0(p.totals.haulOutM3PerDay)} m³/day out.`, "");
  o.push("## Colonies", "", "| Character | Planet | Colony | ISK/day | Template |", "|---|---|---|---|---|");
  for (const t of templates) {
    const c = t.colony;
    o.push(`| ${c.character} | ${short(c.planet.name)} (${c.planet.type}) | ${c.describe} | ${iskShort(c.iskPerHour * 24)} | \`${t.file}\` |`);
  }
  const r = routine(sde, pi, p);
  o.push("", "## Every undock", "",
    "Run the characters in this order, so the goods the factories need are in the shared hangar before their turn. " +
    "Factory steps are only due every " + `${p.restockDays} days.`);
  for (const run of r.runs) {
    o.push("", `### ${run.character}: every ${run.every}`, "",
      `Cargo: ${n0(run.cargoM3.everyVisit)} m³` + (run.cargoM3.factoryVisit > run.cargoM3.everyVisit ? `, ${n0(run.cargoM3.factoryVisit)} m³ on factory days` : ""), "");
    run.steps.forEach((s, i) => o.push(`${i + 1}. ${s}`));
  }
  if (r.stockpile.length) o.push("", "Left in the hangar each day, to sell: " + r.stockpile.map(([t, n]) => `${n0(n)} ${sde.typeName(t)}`).join(", ") + ".");
  if (r.short.length) o.push("", "Not covered by the plan's own colonies (buy it): " + r.short.map(([t, n]) => `${n0(n)}/day ${sde.typeName(t)}`).join(", ") + ".");
  const feeders = p.colonies.filter((c) => c.kind === "factory" && c.local?.length);
  if (feeders.length) {
    o.push("", "## Moving goods between colonies", "");
    for (const c of feeders) {
      o.push(`- **${short(c.planet.name)} (${c.character})** needs ` + c.local!.map((f) =>
        `${n0(f.perHour * 24)}/day ${sde.typeName(f.type)} from ${(made.get(f.type) ?? ["your colonies"]).join(", ")}`).join("; "));
    }
  }
  const h = haulPerTrip(sde, p);
  o.push("", `## Every ${h.every}: haul`, "");
  if (h.buy.length) o.push(`Buy and bring in (${n0(h.m3In)} m³, ${iskShort(h.buyCost)}): ` + h.buy.map((x) => haulLine(sde, x)).join(", "), "");
  o.push(`Take out and sell (${n0(h.m3Out)} m³):`, "", ...h.sell.map((x) => `- ${haulLine(sde, x)} (${tierName(pi.tier.get(x[0]))})`));
  o.push("", "## Build sheets", "",
    "Each colony has a template file: import it in game (Planetary Industry view > Open template > Import & Export), place it, " +
    "then drag the extractor heads onto the hotspot and start the programs. The steps below say the same in words.", "");
  for (const ch of chars) {
    o.push(`### ${ch}`, "");
    for (const t of templates.filter((x) => x.colony.character === ch)) {
      o.push(`#### ${t.name}`, "", `Template \`${t.file}\`: ${t.template.P.length} structures, ${t.links}` +
        (t.fits ? "" : " (the links push it over the command center: drop a factory after importing)"), "");
      colonySheet(sde, pi, p, t.colony, made).forEach((s, i) => o.push(`${i + 1}. ${s}`));
      o.push("");
    }
  }
  return o.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// The routine: what to do on each undock, in order, and exactly where every good goes

export interface Routine {
  /** One run per character, extraction-only characters first so their goods are in the hangar for the factories. */
  runs: Array<{ character: string; every: string; cargoM3: { everyVisit: number; factoryVisit: number }; steps: string[] }>;
  /** Per day: what stays in the hangar to sell. */
  stockpile: Array<[number, number]>;
  /** Factory inputs the plan's colonies don't cover (normally none; bought inputs are listed separately). */
  short: Array<[number, number]>;
}

/** "VI (Commander)" for colonies, as in the build sheets. */
const at = (c: PlanColony) => `${short(c.planet.name)} (${c.character})`;

/**
 * Splits each good the plan makes between the factory colonies that use it and the stockpile. Each factory is filled
 * from its own character's colonies first (nothing to pass through the hangar), then from the colonies with the most
 * left, so inputs come from few places. Ties go by orbit, then character, so the split is the same every time. Rates
 * per hour.
 */
export function allocate(p: SavedPlan, order: (c: PlanColony) => number) {
  const producers = [...p.colonies].filter((c) => c.kind === "extraction").sort((a, b) => order(a) - order(b) || a.character.localeCompare(b.character));
  // Factory colonies' own output can feed other factories too.
  const factories = p.colonies.filter((c) => c.kind === "factory");
  const left = new Map<PlanColony, Map<number, number>>();
  for (const c of [...producers, ...factories]) left.set(c, new Map(c.outputs.map((o) => [o.type, o.perHour])));
  /** to.get(producer) = [[factory, type, perHour]] */
  const to = new Map<PlanColony, Array<{ factory: PlanColony; type: number; perHour: number }>>();
  const from = new Map<PlanColony, Array<{ producer: PlanColony; type: number; perHour: number }>>();
  const missing = new Map<number, number>();
  for (const f of factories) {
    for (const need of f.local ?? []) {
      let want = need.perHour;
      const have = (c: PlanColony) => left.get(c)!.get(need.type) ?? 0;
      const sources = [...producers, ...factories]
        .filter((c) => c !== f && have(c) > 1e-9)
        .sort((a, b) => Number(b.character === f.character) - Number(a.character === f.character) || have(b) - have(a) ||
          order(a) - order(b) || a.character.localeCompare(b.character));
      for (const src of sources) {
        if (want <= 1e-9) break;
        const have = left.get(src)!.get(need.type) ?? 0;
        if (have <= 1e-9) continue;
        const take = Math.min(have, want);
        left.get(src)!.set(need.type, have - take);
        want -= take;
        to.set(src, [...(to.get(src) ?? []), { factory: f, type: need.type, perHour: take }]);
        from.set(f, [...(from.get(f) ?? []), { producer: src, type: need.type, perHour: take }]);
      }
      if (want > 1e-6) missing.set(need.type, (missing.get(need.type) ?? 0) + want);
    }
  }
  return { left, to, from, short: missing };
}

export function routine(sde: Sde, pi: PiData, p: SavedPlan): Routine {
  const orbit = new Map(sde.planetsInSystem(p.system.id).map((x) => [x.id, x.celestial_index]));
  const order = (c: PlanColony) => orbit.get(c.planet.id) ?? c.planet.id;
  const { left, to, from, short: missing } = allocate(p, order);
  const vol = (t: number) => sde.type(t)?.volume ?? 0;
  const days = p.restockDays;
  const qty = (n: number) => n0(n);
  const list = (xs: Array<[number, number]>) => xs.map(([t, n]) => `${qty(n)} ${sde.typeName(t)}`).join(", ");
  const chars = [...new Set(p.colonies.map((c) => c.character))];
  const hasFactory = (ch: string) => p.colonies.some((c) => c.character === ch && c.kind === "factory");
  chars.sort((a, b) => Number(hasFactory(a)) - Number(hasFactory(b))); // stable: plan order otherwise

  const runs = chars.map((character) => {
    const mine = p.colonies.filter((c) => c.character === character).sort((a, b) => order(a) - order(b));
    const ext = mine.filter((c) => c.kind === "extraction");
    const fac = mine.filter((c) => c.kind === "factory");
    const hours = ext[0]?.programHours ?? 24;
    const every = hours % 24 === 0 ? (hours === 24 ? "day" : `${hours / 24} days`) : `${hours} hours`;
    const steps: string[] = [];
    let visitM3 = 0;
    let factoryM3 = 0;
    for (const c of ext) {
      const out = c.outputs.map((o) => [o.type, o.perHour * hours] as [number, number]).filter(([, n]) => n >= 1);
      visitM3 += out.reduce((m, [t, n]) => m + vol(t) * n, 0);
      const dest = out.map(([t, n]) => {
        const parts = (to.get(c) ?? []).filter((x) => x.type === t).map((x) => `${qty(x.perHour * hours)} for ${at(x.factory)}`);
        const rest = (left.get(c)!.get(t) ?? 0) * hours;
        if (rest >= 1) parts.push(`${qty(rest)} to the stockpile`);
        return `${sde.typeName(t)}: ${parts.join(", ")}`;
      });
      steps.push(`${short(c.planet.name)} (${c.planet.type}): restart the extractor programs (${programLabel(c.programHours).replace(" (", ", ").replace(")", "")}, same heads). ` +
        (out.length
          ? `Launch ${list(out)} from the launchpad to the customs office and take it into your hauler. Where it goes: ${dest.join("; ")}.`
          : "Nothing to collect."));
    }
    if (ext.length) steps.push("Dock and put everything in the shared hangar (e.g. your corp hangar in the structure), sorted as above.");
    for (const f of fac) {
      const ins = (from.get(f) ?? []).map((x) => [x.type, x.perHour * 24 * days, x.producer] as const);
      const bought = (f.bought ?? []).map((x) => [x.type, x.perHour * 24 * days] as [number, number]);
      const out = f.outputs.map((o) => [o.type, o.perHour * 24 * days] as [number, number]);
      factoryM3 += [...ins.map(([t, n]) => [t, n] as [number, number]), ...bought, ...out].reduce((m, [t, n]) => m + vol(t) * n, 0);
      const byType = new Map<number, Array<{ n: number; who: PlanColony }>>();
      for (const [t, n, who] of ins) byType.set(t, [...(byType.get(t) ?? []), { n, who }]);
      const take = [...byType].map(([t, xs]) =>
        `${qty(xs.reduce((s, x) => s + x.n, 0))} ${sde.typeName(t)} (from ${xs.map((x) => `${at(x.who)} ${qty(x.n)}`).join(", ")})`);
      if (bought.length) take.push(...bought.map(([t, n]) => `${qty(n)} ${sde.typeName(t)} (bought)`));
      steps.push(`Every ${days} days, ${short(f.planet.name)} (${f.planet.type}) ${sde.typeName(f.product!)} factories: take ` +
        `${take.join(", ")} from the hangar, fly to the ${short(f.planet.name)} customs office and put them in, then in the colony ` +
        `move them from the customs office to the launchpad. Launch the ${list(out)} it made to the customs office and take it.`);
    }
    if (fac.length) steps.push(`Dock and put the factory output in the shared hangar for the stockpile.`);
    return { character, every, cargoM3: { everyVisit: Math.round(visitM3), factoryVisit: Math.round(visitM3 + factoryM3) }, steps };
  });

  const stock = new Map<number, number>();
  for (const m of left.values()) for (const [t, r] of m) if (r * 24 >= 1 && (pi.tier.get(t) ?? 0) >= 1) stock.set(t, (stock.get(t) ?? 0) + r * 24);
  return { runs, stockpile: [...stock], short: [...missing].map(([t, r]) => [t, r * 24] as [number, number]) };
}

// ---------------------------------------------------------------------------------------------------------------
// Storage

const plansDir = (home: string) => join(home, "pi-plans");
const slug = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "plan";

export function savePlan(home: string, p: SavedPlan): string {
  const dir = plansDir(home);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${slug(p.name)}.json`);
  writeFileSync(`${path}.tmp`, JSON.stringify(p, null, 1));
  renameSync(`${path}.tmp`, path);
  return path;
}

export function listPlans(home: string): SavedPlan[] {
  const dir = plansDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).flatMap((f) => {
    try { return [JSON.parse(readFileSync(join(dir, f), "utf8")) as SavedPlan]; } catch { return []; }
  }).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export function loadPlan(home: string, name?: string): SavedPlan {
  const plans = listPlans(home);
  if (!plans.length) throw new UserError("No saved PI plans yet. Run pi_optimize with `save_as` to save one.");
  if (!name) return plans[0];
  const hit = plans.find((p) => slug(p.name) === slug(name));
  if (!hit) throw new UserError(`No saved plan "${name}". Saved plans: ${plans.map((p) => p.name).join(", ")}.`);
  return hit;
}

/**
 * The EVE client's colony template folder: Documents\EVE\PlanetaryInteractionTemplates, or the same under OneDrive's
 * Documents. The folder that already exists wins (the client creates it), then the one whose EVE folder exists.
 */
export function defaultTemplateFolder(home = homedir()): string {
  const candidates = [join(home, "Documents"), join(home, "OneDrive", "Documents")].map((docs) => join(docs, "EVE", "PlanetaryInteractionTemplates"));
  return candidates.find((c) => existsSync(c)) ?? candidates.find((c) => existsSync(join(c, ".."))) ?? candidates[0];
}
