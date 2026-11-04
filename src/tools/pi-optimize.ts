import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Ctx } from "../context.js";
import { piData, tierName } from "../pi.js";
import { optimize, pinCosts, type PlanetInput, type Price, type Slot } from "../pi-optimize.js";
import { marketSummary, resolveMarketScope } from "../market.js";
import { UserError, isk, mapLimit } from "../util.js";
import { READ_ONLY, characterParam, handler, reply } from "./helpers.js";
import { characterPi, resolveSystem } from "./planetary.js";

/** Matches a planet reference ("VII", "7", "J163701 VII") to one of the system's planets. */
function planetRef(planets: Array<{ id: number; name: string; celestial_index: number }>, ref: string) {
  const r = ref.trim().toUpperCase();
  const hit = planets.find((p) => p.name.toUpperCase() === r || p.name.split(" ").pop() === r || String(p.celestial_index) === r);
  if (!hit) throw new UserError(`No planet "${ref}" in this system. Planets: ${planets.map((p) => p.name.split(" ").pop()).join(", ")}.`);
  return hit;
}

export function registerPiOptimizeTool(server: McpServer, ctx: Ctx) {
  server.registerTool(
    "pi_optimize",
    {
      title: "Plan planetary interaction for a system",
      description:
        "Best PI setup for a system across all your characters. Give the in-game scan readings per planet (0-100 per resource, " +
        "read from the scan window's bars or a screenshot). It assigns every free colony slot (or every slot, with " +
        "ignore_existing_colonies) to an extraction colony (which two resources, how many heads, sell P1 or make P2) or a factory " +
        "colony (P2/P3/P4 from inputs bought at the market, sized to the command center and to market volume), maximising ISK/day " +
        "at current prices after sales fees and customs tax. Returns the plan per character, totals (ISK/day, input purchases, " +
        "haul m³), the best options per planet, the best factory margins and warnings. Extraction yields are estimated from the " +
        "scan readings (the assumption is shown); once extractors run, the planets tool shows real output. Read-only.",
      inputSchema: {
        system: z.string().optional().describe("System name or id. Default: the character's current system."),
        character: characterParam,
        abundance: z.record(z.string(), z.record(z.string(), z.number().min(0).max(100))).optional()
          .describe('Scan readings per planet, e.g. {"VII": {"Aqueous Liquids": 100, "Heavy Metals": 100, "Noble Gas": 40}}. ' +
            "Planet as numeral, number or full name; resource names may be shortened. Missing readings use default_abundance."),
        default_abundance: z.number().min(0).max(100).optional().describe("Reading assumed where none is given (default 50)."),
        characters: z.array(z.string()).max(50).optional()
          .describe("Characters to plan for (default: every logged-in character with PI skills)."),
        ignore_existing_colonies: z.boolean().optional()
          .describe("Plan every slot as if all colonies were abandoned (default false: free slots only)."),
        market: z.string().optional().describe("Market for prices (default 'jita')."),
        tax_rate_pct: z.number().min(0).max(100).optional().describe("Customs office tax rate (default 0, e.g. your corp's POCOs)."),
        sell_fee_pct: z.number().min(0).max(30).optional().describe("Sales tax + broker fee when selling (default 5)."),
        p0_per_hour_at_100: z.number().min(100).max(100000).optional()
          .describe("Assumed P0/hour from one 10-head extractor on a resource scanning 100 (default 8000). Calibrate from real extractors."),
        market_share_pct: z.number().min(1).max(100).optional()
          .describe("Max share of an item's daily market volume the plan may trade (default 10)."),
        max_characters_per_planet: z.number().int().min(1).max(20).optional()
          .describe("Max characters extracting on one planet (default 3)."),
        factories: z.boolean().optional().describe("Consider factory colonies running on bought inputs (default true)."),
        max_input_isk_per_day: z.number().min(0).optional()
          .describe("ISK per day you're willing to spend on factory inputs (default 100,000,000). 0 = extraction only."),
        max_haul_m3_per_day: z.number().min(0).optional()
          .describe("m³ per day you can haul in and out of the system combined (default 15,000, about one 100k m³ trip a week)."),
        restock_days: z.number().min(0.25).max(30).optional()
          .describe("Days between visits to restock a factory colony (default 2). Inputs for that long must fit its launchpad and storage."),
      },
      annotations: READ_ONLY,
    },
    handler(async (a) => {
      const sde = await ctx.sde();
      const pi = piData(sde);
      const systemId = await resolveSystem(ctx, sde, a.system, a.character);
      const sysPlanets = sde.planetsInSystem(systemId);
      const def = a.default_abundance ?? 50;

      // Planets with their five resources, at the default reading until the player's readings are applied.
      const planets: PlanetInput[] = [];
      for (const p of sysPlanets) {
        const type = pi.planetType.get(p.type_id);
        if (!type) continue;
        const res = [...pi.p0Planets].filter(([, ts]) => ts.has(type)).map(([id]) => id);
        planets.push({ id: p.id, name: p.name, type, abundance: new Map(res.map((r) => [r, def])) });
      }
      if (!planets.length) throw new UserError(`${sde.system(systemId)?.name} has no planets that support PI.`);
      const read = new Set<number>();
      for (const [pref, readings] of Object.entries(a.abundance ?? {})) {
        const sp = planetRef(sysPlanets, pref);
        const planet = planets.find((p) => p.id === sp.id);
        if (!planet) throw new UserError(`${sp.name} has no PI (shattered or unsupported planet).`);
        read.add(planet.id);
        for (const [rname, v] of Object.entries(readings)) {
          const n = rname.trim().toLowerCase();
          const hit = [...planet.abundance.keys()].find((r) => sde.typeName(r).toLowerCase().startsWith(n));
          if (!hit) {
            throw new UserError(
              `${planet.name} (${planet.type}) has no resource "${rname}". It has: ${[...planet.abundance.keys()].map((r) => sde.typeName(r)).join(", ")}.`,
            );
          }
          planet.abundance.set(hit, v);
        }
      }

      // Colony slots of every PI-capable character.
      const chars = a.characters?.length ? a.characters.map((r) => ctx.character(r)) : ctx.store.list();
      const info = await mapLimit(chars, 4, (c) => characterPi(ctx, sde, c, systemId));
      const slots: Slot[] = [];
      const skipped: string[] = [];
      for (const ci of info) {
        if (ci.max_colonies == null || !ci.max_command_center_level) {
          if (ci.note || a.characters?.length) skipped.push(`${ci.character}: ${ci.note ?? "no Command Center Upgrades"}`);
          continue;
        }
        const n = a.ignore_existing_colonies ? ci.max_colonies : ci.free_slots ?? 0;
        if (n > 0) slots.push({ character: ci.character, slots: n, ccLevel: ci.max_command_center_level });
      }
      if (!slots.length) {
        throw new UserError(
          "No character has a free colony slot and PI skills. Try ignore_existing_colonies, or train Interplanetary Consolidation and Command Center Upgrades.",
        );
      }

      // Prices and daily volume for every P1-P4 commodity.
      const scope = await resolveMarketScope(ctx, a.market);
      const prices = new Map<number, Price>();
      const ids = [...pi.tier].filter(([, t]) => t >= 1).map(([id]) => id);
      await mapLimit(ids, 8, async (id) => {
        const m: any = await marketSummary(ctx, scope, id, { history: true }).catch(() => null);
        if (m?.sell_min) prices.set(id, { sell: m.sell_min, dailyVolume: m.region_history?.avg_daily_volume_7d || undefined });
      });
      if (!prices.size) throw new UserError(`No PI commodity prices found at ${scope.label}.`);

      const params = {
        yieldAtFull: a.p0_per_hour_at_100 ?? 8000,
        taxRate: (a.tax_rate_pct ?? 0) / 100,
        sellFee: (a.sell_fee_pct ?? 5) / 100,
        liquidityShare: (a.market_share_pct ?? 10) / 100,
        maxCharactersPerPlanet: a.max_characters_per_planet ?? 3,
        factories: a.factories !== false,
        maxCapitalPerDay: a.max_input_isk_per_day ?? 100_000_000,
        maxHaulPerDay: a.max_haul_m3_per_day ?? 15_000,
        restockDays: a.restock_days ?? 2,
      };
      const plan = optimize(sde, pi, pinCosts(sde), prices, planets, slots, params);

      const day = (h: number) => isk(h * 24);
      const all = plan.assignments.flatMap((x) => x.colonies);
      const unread = planets.filter((p) => !read.has(p.id)).map((p) => p.name);
      const warnings = [...plan.warnings];
      if (unread.length) warnings.unshift(`No scan readings for ${unread.join(", ")}: assumed ${def} for every resource there.`);
      if (all.some((x) => x.kind === "extraction")) {
        warnings.push(
          "Extraction yields are estimates from scan readings. After the first cycles, compare with real output from the planets tool " +
          "and rerun with p0_per_hour_at_100 adjusted.",
        );
      }
      if (all.some((x) => x.kind === "extraction")) {
        warnings.push(
          "Whether several characters extracting the same planet deplete it together isn't confirmed; the plan avoids putting " +
          "the same resource pair on one planet twice and caps characters per planet.",
        );
      }

      return reply({
        system: sde.systemSummary(systemId),
        market: scope.label,
        assumptions: {
          p0_per_hour_at_100: params.yieldAtFull,
          customs_tax: `${a.tax_rate_pct ?? 0}%`,
          sell_fees: `${a.sell_fee_pct ?? 5}%`,
          prices: "lowest sell order, for outputs and for bought inputs",
          max_market_share: `${a.market_share_pct ?? 10}% of daily volume`,
          max_characters_per_planet: params.maxCharactersPerPlanet,
          max_input_purchases_per_day: isk(params.maxCapitalPerDay),
          max_haul_m3_per_day: params.maxHaulPerDay,
          factory_restock_every: `${params.restockDays} days (launchpad + 1 storage)`,
          slots: a.ignore_existing_colonies ? "every slot (existing colonies ignored)" : "free slots only",
          command_centers: "CPU/PG from game client values per level, 6% kept free for links",
        },
        totals: {
          isk_per_day: day(all.reduce((s, x) => s + x.iskPerHour, 0)),
          input_purchases_per_day: isk(plan.totals.capitalPerDay),
          haul_in_m3_per_day: Math.round(plan.totals.haulIn),
          haul_out_m3_per_day: Math.round(plan.totals.haulOut),
          extraction_colonies: all.filter((x) => x.kind === "extraction").length,
          factory_colonies: all.filter((x) => x.kind === "factory").length,
        },
        plan: plan.assignments.filter((x) => x.colonies.length).map((x) => ({
          character: x.character,
          command_center_level: x.ccLevel,
          isk_per_day: day(x.colonies.reduce((s, c) => s + c.iskPerHour, 0)),
          colonies: x.colonies.map((c) =>
            `${c.planet.name} (${c.planet.type}) ${c.describe}. ~${day(c.iskPerHour)}/day` +
            (c.capitalPerHour ? `, buying ${day(c.capitalPerHour)}/day of inputs` : "")),
        })),
        exports: plan.remainingLocal.length
          ? plan.remainingLocal.map((f) => `${sde.typeName(f.type)} (${tierName(pi.tier.get(f.type))}) ${Math.round(f.perHour * 24).toLocaleString("en-US")}/day`)
          : undefined,
        unused_slots: plan.unused.length ? plan.unused.map((u) => `${u.character}: ${u.slots}`) : undefined,
        unused_slots_reason: plan.unusedReason,
        best_options_by_planet: Object.fromEntries([...plan.bestByPlanet].map(([name, cols]) => [
          name, cols.map((c) => `${day(c.iskPerHour)}/day: ${c.describe}`),
        ])),
        best_factory_margins: plan.factoryMargins.map((m) =>
          `${sde.typeName(m.product)} (${tierName(pi.tier.get(m.product))}): ${isk(m.iskPerHour)} per factory-hour`),
        skipped_characters: skipped.length ? skipped : undefined,
        warnings,
      });
    }),
  );
}
