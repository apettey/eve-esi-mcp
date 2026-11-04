import type { Sde } from "./sde/db.js";
import type { PiData } from "./pi.js";
import { programCycleSeconds } from "./pi-colony.js";
import { LAUNCHPAD_M3, STORAGE_M3, simulate, type Flow, type Layout } from "./pi-layout.js";

/**
 * Build sheets for PI colonies: what to place, which schematic each factory runs, which routes to draw and what to
 * carry on each visit, from the same layout model pi_optimize and pi_colony_calc use. The layout is a hub: every
 * structure links to the launchpad, extractors deliver to it and factories take from and return to it, which keeps
 * routes simple to set up and to check with the planets tool. See docs/PLANETARY_INTERACTION.md section 5.2e.
 */

export interface SetupInput {
  layout: Layout;
  /** Extraction colonies: extractor program length in hours (default 24). */
  programHours?: number;
  /** Factory colonies: days between restocking visits (default 2). */
  restockDays?: number;
  /** Per hour: inputs bought at the market, and inputs taken from other colonies (with where they come from). */
  bought?: Flow[];
  local?: Array<Flow & { from?: string[] }>;
}

const n0 = (n: number) => Math.round(n).toLocaleString("en-US");
const plural = (n: number, word: string) => `${n} ${n === 1 ? word : /y$/.test(word) ? word.replace(/y$/, "ies") : `${word}s`}`;

function period(hours: number): string {
  if (hours % 24 === 0) return hours === 24 ? "day" : `${hours / 24} days`;
  return `${hours} hours`;
}

export function setupSteps(sde: Sde, pi: PiData, s: SetupInput): string[] {
  const l = s.layout;
  const steps: string[] = [];
  const name = (t: number) => sde.typeName(t);
  const vol = (t: number) => sde.type(t)?.volume ?? 0;
  const extracting = l.extractors.length > 0;
  const visitHours = extracting ? (s.programHours ?? 24) : (s.restockDays ?? 2) * 24;
  // Factory colonies run on what is brought in, so simulate them fully supplied.
  const sim = simulate(pi, { ...l, buyMissing: !extracting });

  // What to place.
  const byTier = new Map<number, number>();
  for (const f of l.factories) {
    const t = pi.tier.get(f.product)!;
    byTier.set(t, (byTier.get(t) ?? 0) + f.count);
  }
  const place = [
    plural(l.launchpads, "Launchpad"),
    l.storage ? plural(l.storage, "Storage Facility") : "",
    l.extractors.length ? plural(l.extractors.length, "Extractor Control Unit") : "",
    ...[...byTier].sort((a, b) => a[0] - b[0]).map(([t, n]) => plural(n, pi.factoryName.get(t)!)),
  ].filter(Boolean);
  steps.push(`Command center at level ${l.ccLevel}. Place ${place.join(", ")}; link each one straight to the launchpad, ` +
    "close to it (links cost CPU/powergrid by length).");

  // Extractors.
  l.extractors.forEach((e, i) => {
    const hours = s.programHours ?? 24;
    const cyc = programCycleSeconds(hours) / 60;
    steps.push(`Extractor ${i + 1}: ${name(e.resource)}, ${e.heads} heads spread over the brightest area (no overlap), ` +
      `${period(hours) === "day" ? "1-day" : period(hours)} program (${cyc >= 60 ? `${cyc / 60} h` : `${cyc} min`} cycles), ` +
      `about ${n0(e.perHour)}/h. Route its ${name(e.resource)} to the launchpad.`);
  });

  // Factories and their routes.
  for (const f of [...l.factories].sort((a, b) => pi.tier.get(a.product)! - pi.tier.get(b.product)!)) {
    const sch = pi.schematic.get(f.product)!;
    const busy = sim.utilisation.get(f.product) ?? 1;
    const each = f.count === 1 ? "the factory" : `each of the ${f.count}`;
    steps.push(`${f.count} x ${pi.factoryName.get(pi.tier.get(f.product)!)} on schematic ${name(f.product)}: route ` +
      sch.inputs.map(([i, q]) => `${n0(q)} ${name(i)}`).join(" + ") + ` per cycle from the launchpad to ${each}, and ` +
      `${name(f.product)} from ${f.count === 1 ? "it" : "each"} back to the launchpad` +
      (busy < 0.98 ? ` (expect them busy ${Math.round(busy * 100)}% of the time)` : "") + ".");
  }

  // Each visit.
  const every = `Every ${period(visitHours)}`;
  const take = [...sim.leftover].filter(([t, r]) => (pi.tier.get(t) ?? 0) >= 1 && r * visitHours >= 1);
  const visit: string[] = [];
  if (extracting) visit.push("restart the extractor programs");
  const incoming: Array<Flow & { note: string }> = [
    ...(s.local ?? []).map((f) => ({ ...f, note: f.from?.length ? `from ${f.from.join(", ")}` : "from your colonies" })),
    ...(s.bought ?? []).map((f) => ({ ...f, note: "bought" })),
  ];
  if (!s.local && !s.bought) for (const [type, perHour] of sim.bought) incoming.push({ type, perHour, note: "" });
  if (incoming.length) {
    visit.push(`bring in ${incoming.map((f) => `${n0(f.perHour * visitHours)} ${name(f.type)}${f.note ? ` (${f.note})` : ""}`).join(", ")}`);
  }
  if (take.length) visit.push(`collect ${take.map(([t, r]) => `${n0(r * visitHours)} ${name(t)}`).join(", ")} from the launchpad`);
  if (visit.length) steps.push(`${every}: ${visit.join("; ")}.`);

  // Room on the launchpad: inputs for a visit, outputs between visits, and P0 the factories can't keep up with.
  const cap = l.launchpads * LAUNCHPAD_M3 + l.storage * STORAGE_M3;
  const perVisit = incoming.reduce((m, f) => m + vol(f.type) * f.perHour * visitHours, 0) +
    take.reduce((m, [t, r]) => m + vol(t) * r * visitHours, 0);
  const surplus = [...sim.leftover].filter(([t, r]) => pi.tier.get(t) === 0 && r > 1);
  const surplusM3 = surplus.reduce((m, [t, r]) => m + vol(t) * r, 0); // per hour
  if (surplusM3 > 0) {
    const free = cap - perVisit;
    const days = free > 0 ? free / surplusM3 / 24 : 0;
    steps.push(`The factories can't use all the ${surplus.map(([t, r]) => `${name(t)} (${n0(r * 24)}/day spare)`).join(", ")}: ` +
      `it piles up on the launchpad and fills it in about ${days < 1 ? "less than a day" : `${Math.floor(days)} days`}. Before then, ` +
      "delete or launch the spare P0, or the factories' output has nowhere to go.");
  } else if (perVisit > cap) {
    steps.push(`A visit's goods (${n0(perVisit)} m³) don't fit the launchpad${l.storage ? " and storage" : ""} (${n0(cap)} m³): visit more often.`);
  }
  return steps;
}
