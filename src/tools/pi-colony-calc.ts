import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Ctx } from "../context.js";
import type { Sde } from "../sde/db.js";
import { PI_ATTR, piData, planetTypeRef, tierName, type PiData } from "../pi.js";
import { extractorProgram } from "../pi-colony.js";
import {
  CC_LEVELS, COMMAND_CENTER_M3, LAUNCHPAD_M3, LINK_RESERVE, MAX_HEADS, STORAGE_M3, layoutCapacity, layoutCost, pinCosts, simulate,
  type Layout, type PinCosts, type Simulation,
} from "../pi-layout.js";
import { marketSummary, resolveMarketScope } from "../market.js";
import { UserError, isk, mapLimit } from "../util.js";
import { READ_ONLY, characterParam, handler, reply } from "./helpers.js";
import { typeRef } from "./universe.js";
import { DEFAULT_YIELD_AT_100 } from "./pi-optimize.js";

const SCOPE = "esi-planets.manage_planets.v1";
const n0 = (n: number) => Math.round(n).toLocaleString("en-US");
const GROUP = { storage: 1029, launchpad: 1030, ecu: 1063, processor: 1028 } as const;

interface Econ {
  sellFee: number;
  taxRate: number;
  prices: Map<number, number>;
}

interface Evaluation {
  layout: Layout;
  used: { cpu: number; pg: number };
  cap: { cpu: number; pg: number };
  fits: boolean;
  sim: Simulation;
  iskPerHour: number;
  salesPerHour: number;
  boughtPerHour: number;
  missingPrices: number[];
}

function evaluate(sde: Sde, pi: PiData, costs: PinCosts, layout: Layout, econ: Econ): Evaluation {
  const used = layoutCost(costs, pi, layout);
  const cap = layoutCapacity(layout);
  const sim = simulate(pi, layout);
  const taxBase = (t: number) => sde.attr(t, PI_ATTR.exportTaxBase) ?? 0;
  const missingPrices: number[] = [];
  let sales = 0;
  for (const [t, perHour] of sim.leftover) {
    if (pi.tier.get(t) === 0) continue; // unprocessed P0 stays on the planet
    const p = econ.prices.get(t);
    if (p == null) { missingPrices.push(t); continue; }
    sales += perHour * (p * (1 - econ.sellFee) - taxBase(t) * econ.taxRate);
  }
  let bought = 0;
  for (const [t, perHour] of [...sim.bought, ...(layout.imports ?? []).map((f) => [f.type, f.perHour] as const)]) {
    bought += perHour * ((econ.prices.get(t) ?? 0) + taxBase(t) * econ.taxRate * 0.5);
  }
  return {
    layout, used, cap, fits: used.cpu <= cap.cpu + 1e-9 && used.pg <= cap.pg + 1e-9, sim,
    iskPerHour: sales - bought, salesPerHour: sales, boughtPerHour: bought, missingPrices,
  };
}

/** One-step changes to a layout, each with a description. */
function variations(pi: PiData, l: Layout, grow: boolean): Array<{ text: string; layout: Layout }> {
  const out: Array<{ text: string; layout: Layout }> = [];
  const d = grow ? 1 : -1;
  l.extractors.forEach((e, i) => {
    const heads = e.heads + d;
    if (heads < 1 || heads > MAX_HEADS) return;
    const extractors = l.extractors.map((x, j) => (j === i ? { ...x, heads, perHour: (x.perHour * heads) / x.heads } : x));
    out.push({ text: `${grow ? "add" : "remove"} 1 head on extractor ${i + 1}`, layout: { ...l, extractors } });
  });
  const products = new Set(l.factories.map((f) => f.product));
  // Growing: a basic factory for any extracted resource, even one not processed yet.
  if (grow) for (const e of l.extractors) {
    const p1 = [...pi.schematic.values()].find((s) => pi.tier.get(s.output) === 1 && s.inputs[0]?.[0] === e.resource)?.output;
    if (p1) products.add(p1);
  }
  for (const product of products) {
    const cur = l.factories.find((f) => f.product === product)?.count ?? 0;
    if (cur + d < 0) continue;
    const factories = cur ? l.factories.map((f) => (f.product === product ? { ...f, count: f.count + d } : f)) : [...l.factories, { product, count: 1 }];
    out.push({ text: `${grow ? "add" : "remove"} 1 factory for ${product}`, layout: { ...l, factories: factories.filter((f) => f.count > 0) } });
  }
  if (!grow && l.storage > 0) out.push({ text: "remove 1 storage facility", layout: { ...l, storage: l.storage - 1 } });
  return out;
}

/** Converts an ESI colony layout into the shared layout model, with real link lengths. */
function fromEsi(sde: Sde, pi: PiData, planetId: number, ccLevel: number, esi: any, now: number): Layout {
  const pins: any[] = esi?.pins ?? [];
  const extractors: Layout["extractors"] = [];
  const factories = new Map<number, number>();
  let storage = 0;
  let launchpads = 0;
  for (const pin of pins) {
    const group = sde.type(pin.type_id)?.group_id;
    if (group === GROUP.storage) storage++;
    if (group === GROUP.launchpad) launchpads++;
    const ex = pin.extractor_details;
    if (ex?.product_type_id) {
      const install = pin.install_time ? Date.parse(pin.install_time) : null;
      const expiry = pin.expiry_time ? Date.parse(pin.expiry_time) : null;
      const prog = install && expiry && ex.cycle_time && ex.qty_per_cycle
        ? extractorProgram(ex.qty_per_cycle, ex.cycle_time, install, expiry, now)
        : null;
      extractors.push({ resource: ex.product_type_id, heads: ex.heads?.length ?? 1, perHour: prog?.avgPerHour ?? 0 });
      continue;
    }
    const sid = pin.schematic_id ?? pin.factory_details?.schematic_id;
    const s = sid ? [...pi.schematic.values()].find((x) => x.id === sid) : undefined;
    if (s) factories.set(s.output, (factories.get(s.output) ?? 0) + 1);
  }
  // Link length: great-circle distance between the pins (ESI gives latitude/longitude in radians).
  const radiusKm = (sde.planetRadius(planetId) ?? 0) / 1000;
  const byId = new Map(pins.map((p) => [p.pin_id, p]));
  let totalKm = 0;
  for (const link of esi?.links ?? []) {
    const a = byId.get(link.source_pin_id);
    const b = byId.get(link.destination_pin_id);
    if (!a || !b || !radiusKm) continue;
    const h = Math.sin((b.latitude - a.latitude) / 2) ** 2 + Math.cos(a.latitude) * Math.cos(b.latitude) * Math.sin((b.longitude - a.longitude) / 2) ** 2;
    totalKm += 2 * radiusKm * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  return {
    ccLevel, extractors, storage, launchpads,
    factories: [...factories].map(([product, count]) => ({ product, count })),
    links: radiusKm ? { count: (esi?.links ?? []).length, totalKm } : undefined,
  };
}

export function registerPiColonyCalcTool(server: McpServer, ctx: Ctx) {
  server.registerTool(
    "pi_colony_calc",
    {
      title: "PI colony calculator",
      description:
        "Deterministic calculator for one PI colony layout, using the same model as pi_optimize. Give a layout (planet type, " +
        "command center level, extractors with heads and a scan reading or real qty_per_cycle, factories by product, storage, " +
        "launchpads) or `from_colony` to check a real colony from ESI. Returns CPU/powergrid used against the command center " +
        "(and whether it fits), extractor output, what each factory does (busy share, short of what), production per day " +
        "(made, used on the planet, exported, unprocessed P0, bought), ISK/day at market prices, storage time-to-full, and the " +
        "best single changes (e.g. 'add 1 basic factory', 'remove 1 head') with their ISK/day effect. Read-only.",
      inputSchema: {
        planet_type: z.string().optional().describe("Planet type, e.g. 'Ice'. Not needed with from_colony."),
        command_center_level: z.number().int().min(0).max(5).optional().describe("Command center level (default 5)."),
        extractors: z.array(z.object({
          resource: z.string().describe("P0 resource, e.g. 'Heavy Metals'."),
          heads: z.number().int().min(1).max(10).optional().describe("Extractor heads (default 10)."),
          reading: z.number().min(0).max(100).optional().describe("Scan reading 0-100 at the heads."),
          qty_per_cycle: z.number().min(1).optional().describe("Real qty_per_cycle (from the planets tool or the game)."),
          cycle_minutes: z.number().min(1).optional().describe("Cycle length with qty_per_cycle (default 15)."),
          program_hours: z.number().min(1).max(336).optional().describe("Program length with qty_per_cycle (default 24)."),
          p0_per_hour: z.number().min(0).optional().describe("Output per hour, if you already know it."),
        })).max(6).optional(),
        factories: z.array(z.object({
          product: z.string().describe("What the factory makes, e.g. 'Toxic Metals' (a P1 = basic factory) or 'Coolant'."),
          count: z.number().int().min(1).max(60),
        })).max(20).optional(),
        storage_facilities: z.number().int().min(0).max(10).optional().describe("Storage facilities (default 0)."),
        launchpads: z.number().int().min(0).max(5).optional().describe("Launchpads (default 1)."),
        links: z.object({ count: z.number().int().min(0), total_km: z.number().min(0) }).optional()
          .describe(`Links and their total length; without it ${LINK_RESERVE * 100}% of CPU/PG is kept for links.`),
        imports: z.array(z.object({ product: z.string(), per_day: z.number().min(0) })).max(10).optional()
          .describe("Goods brought into the colony per day (from other colonies or bought)."),
        buy_missing_inputs: z.boolean().optional().describe("Bring in whatever factories lack, priced as bought (default false)."),
        from_colony: z.object({ planet: z.string().describe("Planet name, e.g. 'J163701 VII'."), character: characterParam })
          .optional().describe("Check a real colony: reads its layout from ESI instead of the layout arguments."),
        p0_per_hour_at_100: z.number().min(100).max(200000).optional()
          .describe(`P0/hour of a 10-head extractor at a reading of 100 (default ${DEFAULT_YIELD_AT_100}; pi_optimize calibrates this).`),
        market: z.string().optional().describe("Market for prices (default 'jita')."),
        sell_fee_pct: z.number().min(0).max(30).optional().describe("Sales tax + broker fee (default 5)."),
        tax_rate_pct: z.number().min(0).max(100).optional().describe("Customs office tax rate (default 0)."),
      },
      annotations: READ_ONLY,
    },
    handler(async (a) => {
      const sde = await ctx.sde();
      const pi = piData(sde);
      const costs = pinCosts(sde);
      const now = Date.now();
      let planetType: string | undefined = a.planet_type ? planetTypeRef(pi, a.planet_type) : undefined;
      let layout: Layout;
      let source: string;
      const notes: string[] = [];

      if (a.from_colony) {
        const c = ctx.character(a.from_colony.character);
        const colonies = await ctx.esi.get<any[]>(`/characters/${c.id}/planets`, { character: c, scope: SCOPE });
        const want = a.from_colony.planet.trim().toLowerCase();
        const col = colonies.find((p) => (sde.planetName(p.planet_id) ?? "").toLowerCase() === want);
        if (!col) {
          throw new UserError(
            `${c.name} has no colony on "${a.from_colony.planet}". Colonies: ${colonies.map((p) => sde.planetName(p.planet_id) ?? p.planet_id).join(", ") || "none"}.`,
          );
        }
        const esi = await ctx.esi.get<any>(`/characters/${c.id}/planets/${col.planet_id}`, { character: c, scope: SCOPE });
        layout = fromEsi(sde, pi, col.planet_id, col.upgrade_level, esi, now);
        planetType = planetTypeRef(pi, col.planet_type);
        source = `${c.name}'s colony on ${sde.planetName(col.planet_id)} (ESI, ${col.last_update ? `as of ${col.last_update}` : "time unknown"})`;
        if (layout.extractors.some((e) => !e.perHour)) notes.push("Extractors without a running program count as 0 output.");
      } else {
        const yAt100 = a.p0_per_hour_at_100 ?? DEFAULT_YIELD_AT_100;
        const extractors = (a.extractors ?? []).map((e) => {
          const resource = typeRef(sde, e.resource);
          if (pi.tier.get(resource) !== 0) throw new UserError(`${sde.typeName(resource)} is not a raw (P0) resource.`);
          if (planetType && !pi.p0Planets.get(resource)?.has(planetType)) {
            throw new UserError(`${planetType} planets have no ${sde.typeName(resource)}. They have: ${[...pi.p0Planets].filter(([, t]) => t.has(planetType!)).map(([r]) => sde.typeName(r)).join(", ")}.`);
          }
          const heads = e.heads ?? MAX_HEADS;
          let perHour: number;
          if (e.p0_per_hour != null) perHour = e.p0_per_hour;
          else if (e.qty_per_cycle != null) {
            const cycle = (e.cycle_minutes ?? 15) * 60;
            perHour = extractorProgram(e.qty_per_cycle, cycle, 0, (e.program_hours ?? 24) * 3_600_000, 0).avgPerHour;
          } else if (e.reading != null) perHour = yAt100 * (e.reading / 100) * (heads / MAX_HEADS);
          else throw new UserError(`Extractor on ${sde.typeName(resource)}: give a scan reading, qty_per_cycle or p0_per_hour.`);
          return { resource, heads, perHour };
        });
        const factories = (a.factories ?? []).map((f) => {
          const product = typeRef(sde, f.product);
          const t = pi.tier.get(product);
          if (t == null || t === 0 || !pi.schematic.has(product)) throw new UserError(`${sde.typeName(product)} isn't made in a PI factory.`);
          if (t === 4 && planetType && !pi.highTech.has(planetType)) {
            throw new UserError(`${sde.typeName(product)} needs a High-Tech Production Plant, which only ${[...pi.highTech].join(" and ")} planets have.`);
          }
          return { product, count: f.count };
        });
        if (!extractors.length && !factories.length) throw new UserError("Give extractors and/or factories, or from_colony.");
        layout = {
          ccLevel: a.command_center_level ?? 5, extractors, factories,
          storage: a.storage_facilities ?? 0, launchpads: a.launchpads ?? 1,
          links: a.links ? { count: a.links.count, totalKm: a.links.total_km } : undefined,
          imports: (a.imports ?? []).map((i) => ({ type: typeRef(sde, i.product), perHour: i.per_day / 24 })),
          buyMissing: a.buy_missing_inputs ?? false,
        };
        source = "layout given";
        if (a.extractors?.some((e) => e.reading != null && e.qty_per_cycle == null && e.p0_per_hour == null)) {
          notes.push(`Output from scan readings uses ${n0(yAt100)} P0/h per 10 heads at a reading of 100 (an estimate; pi_optimize calibrates it).`);
        }
      }

      // Prices for everything the layout or its one-step variations could make or need.
      const types = new Set<number>();
      const collect = (l: Layout) => { for (const m of Object.values(simulate(pi, l))) for (const t of (m as Map<number, number>).keys()) types.add(t); };
      collect(layout);
      for (const v of [...variations(pi, layout, true), ...variations(pi, layout, false)]) collect(v.layout);
      for (const f of layout.factories) for (const [i] of pi.schematic.get(f.product)!.inputs) types.add(i);
      const scope = await resolveMarketScope(ctx, a.market);
      const prices = new Map<number, number>();
      await mapLimit([...types].filter((t) => (pi.tier.get(t) ?? 0) >= 1), 8, async (t) => {
        const m: any = await marketSummary(ctx, scope, t).catch(() => null);
        if (m?.sell_min) prices.set(t, m.sell_min);
      });
      const econ: Econ = { sellFee: (a.sell_fee_pct ?? 5) / 100, taxRate: (a.tax_rate_pct ?? 0) / 100, prices };

      const ev = evaluate(sde, pi, costs, layout, econ);
      const day = (h: number) => isk(h * 24);
      const name = (t: number) => `${sde.typeName(t)} (${tierName(pi.tier.get(t))})`;
      const perDay = (m: Map<number, number>, filter: (t: number) => boolean = () => true) =>
        [...m].filter(([t, v]) => v > 1e-6 && filter(t)).map(([t, v]) => `${name(t)} ${n0(v * 24)}/day`);

      // Suggestions: the best single changes. If it doesn't fit, cheapest removals that make it fit.
      const describeChange = (text: string) => text.replace(/factory for (\d+)/, (_, id) =>
        `${pi.factoryName.get(pi.tier.get(Number(id))!)} (${sde.typeName(Number(id))})`);
      /** "remove 1 X" repeated 4 times reads as "remove 4 x X". */
      const collapse = (steps: string[]) => {
        const counts = new Map<string, number>();
        for (const st of steps) counts.set(st, (counts.get(st) ?? 0) + 1);
        return [...counts].map(([st, n]) => (n > 1 ? st.replace(/^(add|remove) 1 /, `$1 ${n} x `) : st)).join(", ");
      };
      const suggestions: string[] = [];
      if (!ev.fits) {
        let cur = layout;
        const steps: string[] = [];
        for (let i = 0; i < 40; i++) {
          const opts = variations(pi, cur, false).map((v) => ({ ...v, e: evaluate(sde, pi, costs, v.layout, econ) }));
          if (!opts.length) break;
          const over = (e: Evaluation) => Math.max(0, e.used.cpu - e.cap.cpu) / e.cap.cpu + Math.max(0, e.used.pg - e.cap.pg) / e.cap.pg;
          // Prefer changes that fix the overage, then the smallest ISK loss.
          opts.sort((x, y) => Number(y.e.fits) - Number(x.e.fits) || over(x.e) - over(y.e) || y.e.iskPerHour - x.e.iskPerHour);
          cur = opts[0].layout;
          steps.push(describeChange(opts[0].text));
          if (opts[0].e.fits) {
            suggestions.push(`To fit: ${collapse(steps)} -> ~${day(opts[0].e.iskPerHour)}/day`);
            break;
          }
        }
        if (!suggestions.length) suggestions.push("No small change makes this fit; use fewer factories or a higher command center level.");
      } else {
        const opts = variations(pi, layout, true)
          .map((v) => ({ ...v, e: evaluate(sde, pi, costs, v.layout, econ) }))
          .filter((o) => o.e.fits && o.e.iskPerHour > ev.iskPerHour + 1)
          .sort((x, y) => y.e.iskPerHour - x.e.iskPerHour)
          .slice(0, 3);
        for (const o of opts) suggestions.push(`${describeChange(o.text)}: +${day(o.e.iskPerHour - ev.iskPerHour)}/day (still fits)`);
        // Removing something idle frees CPU/PG without losing output.
        for (const f of layout.factories) {
          const u = ev.sim.utilisation.get(f.product) ?? 0;
          const idle = Math.floor(f.count * (1 - u) + 1e-9);
          if (idle >= 1) {
            suggestions.push(`${idle} of ${f.count} ${sde.typeName(f.product)} factories have nothing to do: remove them, or feed them ` +
              "(imports / buy_missing_inputs show what that would earn)");
          }
        }
        if (!suggestions.length) suggestions.push("No single extra head or factory adds value within CPU/PG.");
      }

      const shortOf = (product: number) => pi.schematic.get(product)!.inputs
        .filter(([i]) => (ev.sim.consumed.get(i) ?? 0) + 1e-6 < ((pi.schematic.get(product)!.inputs.find(([x]) => x === i)![1] * 3600) / pi.schematic.get(product)!.cycle))
        .map(([i]) => sde.typeName(i));
      const capacity = layout.launchpads * LAUNCHPAD_M3 + layout.storage * STORAGE_M3 + COMMAND_CENTER_M3;
      const pileM3 = [...ev.sim.leftover].reduce((s, [t, v]) => s + v * (sde.type(t)?.volume ?? 0), 0);
      const exportM3 = [...ev.sim.leftover].filter(([t]) => pi.tier.get(t) !== 0).reduce((s, [t, v]) => s + v * (sde.type(t)?.volume ?? 0), 0);
      const cc = CC_LEVELS[Math.max(0, Math.min(layout.ccLevel, 5))];

      return reply({
        source,
        planet_type: planetType,
        command_center_level: layout.ccLevel,
        fits: ev.fits,
        cpu: `${n0(ev.used.cpu)} / ${n0(ev.cap.cpu)} tf (${Math.round((ev.used.cpu / ev.cap.cpu) * 100)}%)`,
        powergrid: `${n0(ev.used.pg)} / ${n0(ev.cap.pg)} MW (${Math.round((ev.used.pg / ev.cap.pg) * 100)}%)`,
        links: layout.links
          ? `${layout.links.count} links, ${n0(layout.links.totalKm)} km (included above)`
          : `not given: ${LINK_RESERVE * 100}% of the command center (${n0(cc.cpu * LINK_RESERVE)} tf, ${n0(cc.pg * LINK_RESERVE)} MW) kept for them`,
        structures: [
          `Command Center (level ${layout.ccLevel})`,
          layout.launchpads ? `${layout.launchpads} x Launchpad` : "",
          layout.storage ? `${layout.storage} x Storage Facility` : "",
          ...layout.extractors.map((e, i) => `Extractor ${i + 1}: ${sde.typeName(e.resource)}, ${e.heads} heads, ${n0(e.perHour)}/h`),
          ...layout.factories.map((f) => `${f.count} x ${pi.factoryName.get(pi.tier.get(f.product)!)} (${sde.typeName(f.product)})`),
        ].filter(Boolean),
        factories: layout.factories.map((f) => {
          const u = ev.sim.utilisation.get(f.product) ?? 0;
          const short = u < 0.999 ? shortOf(f.product) : [];
          return `${name(f.product)} x${f.count}: ${Math.round(u * 100)}% busy${short.length ? ` (short of ${short.join(", ")})` : ""}`;
        }),
        per_day: {
          made: perDay(ev.sim.made),
          used_on_planet: perDay(ev.sim.consumed),
          exported: perDay(ev.sim.leftover, (t) => pi.tier.get(t) !== 0),
          unprocessed_p0: perDay(ev.sim.leftover, (t) => pi.tier.get(t) === 0),
          bought_in: perDay(new Map([...ev.sim.bought, ...(layout.imports ?? []).map((f) => [f.type, f.perHour] as [number, number])])),
        },
        economics: {
          market: scope.label,
          isk_per_day: day(ev.iskPerHour),
          sales_per_day: day(ev.salesPerHour),
          inputs_per_day: ev.boughtPerHour ? day(ev.boughtPerHour) : undefined,
          haul_out_m3_per_day: n0(exportM3 * 24),
          no_price: ev.missingPrices.length ? ev.missingPrices.map((t) => sde.typeName(t)) : undefined,
          fees: `${a.sell_fee_pct ?? 5}% sales fees, ${a.tax_rate_pct ?? 0}% customs tax`,
        },
        storage: `${n0(capacity)} m³` + (pileM3 > 0 ? `, full in ~${n0(capacity / pileM3)} h if nothing is launched` : ""),
        suggestions,
        notes: notes.length ? notes : undefined,
      });
    }),
  );
}
