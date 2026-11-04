import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Ctx } from "../context.js";
import type { StoredCharacter } from "../auth/store.js";
import type { Sde } from "../sde/db.js";
import {
  PI_ATTR, PI_SKILL, balancedChain, makeableOn, minimalPlanetSets, perHour, piData, planetTypeRef, rawInputs, tierName,
  usedInIndustry, type PiData,
} from "../pi.js";
import { loadSkills } from "../skills.js";
import { UserError, isk, mapLimit, round } from "../util.js";
import { READ_ONLY, characterParam, handler, reply } from "./helpers.js";
import { systemRef, typeRef } from "./universe.js";

const PLANETS_SCOPE = "esi-planets.manage_planets.v1";

const num = (n: number) => round(n, 2).toLocaleString("en-US");

function capList(list: string[], max: number): string[] {
  return list.length > max ? [...list.slice(0, max), `+${list.length - max} more`] : list;
}

/** "Base Metals (Barren, Gas, Lava, Plasma, Storm)" */
function p0WithPlanets(sde: Sde, pi: PiData, p0: number): string {
  return `${sde.typeName(p0)} (${[...(pi.p0Planets.get(p0) ?? [])].sort().join(", ")})`;
}

function recipe(sde: Sde, pi: PiData, typeId: number): string | undefined {
  const s = pi.schematic.get(typeId);
  if (!s) return undefined;
  const ins = s.inputs.map(([i, q]) => `${q} ${sde.typeName(i)} (${tierName(pi.tier.get(i))})`).join(" + ");
  const cycle = s.cycle >= 3600 ? `${s.cycle / 3600} h` : `${s.cycle / 60} min`;
  return `${ins} -> ${s.outputQty} per ${cycle} (${num(perHour(pi, typeId))}/h per factory)`;
}

function factoryFor(pi: PiData, typeId: number): string {
  const t = pi.tier.get(typeId)!;
  const name = pi.factoryName.get(t) ?? "factory";
  return t === 4 ? `${name} (${[...pi.highTech].sort().join(" or ")} only)` : `${name} (any planet type)`;
}

/** P2+ products that can be made from P0 on these planet types, grouped by tier. */
function makeableByTier(pi: PiData, sde: Sde, planetTypes: Iterable<string>, minTier = 1) {
  const have = [...planetTypes];
  const out: Record<string, string[]> = {};
  for (const [id, t] of pi.tier) {
    if (t < minTier || !pi.schematic.has(id) || !makeableOn(pi, id, have)) continue;
    (out[tierName(t)] ??= []).push(sde.typeName(id));
  }
  for (const k of Object.keys(out)) out[k].sort();
  // A complete tier reads better as a count than as 24 names.
  const sizes = new Map<string, number>();
  for (const [id, t] of pi.tier) if (pi.schematic.has(id)) sizes.set(tierName(t), (sizes.get(tierName(t)) ?? 0) + 1);
  const shown: Record<string, string[] | string> = {};
  for (const [k, v] of Object.entries(out)) shown[k] = v.length === sizes.get(k) ? `all ${v.length}` : v;
  return shown;
}

interface CharacterPi {
  character: string;
  colonies_here?: string[];
  colonies_elsewhere?: string[];
  colonies_total?: number;
  max_colonies?: number;
  free_slots?: number;
  max_command_center_level?: number;
  note?: string;
}

/** One character's PI capacity (from skills) and its colonies in `systemId`. Never throws: problems become `note`. */
export async function characterPi(ctx: Ctx, sde: Sde, c: StoredCharacter, systemId: number): Promise<CharacterPi> {
  const out: CharacterPi = { character: c.name };
  const notes: string[] = [];
  try {
    const colonies = await ctx.esi.get<any[]>(`/characters/${c.id}/planets`, { character: c, scope: PLANETS_SCOPE });
    out.colonies_total = colonies.length;
    out.colonies_here = colonies
      .filter((p) => p.solar_system_id === systemId)
      .map((p) => `${sde.planetName(p.planet_id) ?? `Planet ${p.planet_id}`} (${p.planet_type}, CC level ${p.upgrade_level}, ${p.num_pins} pins)`);
    const elsewhere = new Map<number, number>();
    for (const p of colonies) if (p.solar_system_id !== systemId) elsewhere.set(p.solar_system_id, (elsewhere.get(p.solar_system_id) ?? 0) + 1);
    out.colonies_elsewhere = [...elsewhere].map(([sys, n]) => `${sde.system(sys)?.name ?? `System ${sys}`} (${n})`);
  } catch (err) {
    notes.push((err as Error).message);
  }
  try {
    const skills = await loadSkills(ctx.esi, c);
    const level = (name: string) => {
      const id = sde.typeIdByName(name);
      return id ? skills.levels.get(id)?.active ?? 0 : 0;
    };
    out.max_colonies = 1 + level(PI_SKILL.interplanetaryConsolidation);
    out.max_command_center_level = level(PI_SKILL.commandCenterUpgrades);
    if (out.colonies_total != null) out.free_slots = Math.max(0, out.max_colonies - out.colonies_total);
  } catch (err) {
    notes.push((err as Error).message);
  }
  if (notes.length) out.note = notes.join(" ");
  return out;
}

/** System id from a name/id, or the character's current system when omitted or 'current'. */
export async function resolveSystem(ctx: Ctx, sde: Sde, system: string | undefined, character: string | undefined): Promise<number> {
  if (system && system.toLowerCase() !== "current") return systemRef(sde, system);
  const c = ctx.character(character);
  return (await ctx.esi.get<any>(`/characters/${c.id}/location`, { character: c, scope: "esi-location.read_location.v1" })).solar_system_id;
}

export function registerPlanetaryTools(server: McpServer, ctx: Ctx) {
  server.registerTool(
    "pi_system_planets",
    {
      title: "Planetary interaction options for a system",
      description:
        "What planetary interaction (PI) a solar system supports, built for wormhole and multi-character PI: every planet with its " +
        "type (Shattered and other planets without PI flagged), which raw resources (P0) each planet type offers, the P2/P3/P4 " +
        "products the system's planets can make on their own, what each planet type can make alone, which products are one " +
        "planet type short, and, for every logged-in character (or those in `characters`), their colonies in this system, " +
        "free colony slots and max command center level (alts with no PI skills are listed by name only). Defaults to the active character's current system. " +
        "Per-planet resource abundance isn't available from ESI. Use pi_product for a product's full chain and planets for colony status.",
      inputSchema: {
        system: z.string().optional().describe("System name or id, e.g. 'J123456' or 'Jita'. Default: the character's current system."),
        character: characterParam,
        characters: z.array(z.string()).max(50).optional()
          .describe("Characters whose colonies and slots to include (default: every logged-in character)."),
        extra_planet_types: z.array(z.string()).max(8).optional()
          .describe("What-if: planet types to add, e.g. ['Plasma'] for planets reachable through a static connection."),
        include_characters: z.boolean().optional().describe("Include characters' colonies and slots (default true)."),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ system, character, characters, extra_planet_types, include_characters }) => {
      const sde = await ctx.sde();
      const pi = piData(sde);
      const systemId = await resolveSystem(ctx, sde, system, character);

      const planets = sde.planetsInSystem(systemId);
      const typesHere = new Map<string, string[]>();
      const planetList = planets.map((p) => {
        const t = pi.planetType.get(p.type_id);
        if (t) typesHere.set(t, [...(typesHere.get(t) ?? []), p.name]);
        return `${p.name}: ${t ?? `${sde.typeName(p.type_id).replace(/^Planet \((.*)\)$/, "$1")} (no PI)`}`;
      });
      const extra = (extra_planet_types ?? []).map((t) => planetTypeRef(pi, t));
      const available = new Set([...typesHere.keys(), ...extra]);

      // Raw resources: which planets in the system have each P0.
      const resources = [...pi.p0Planets.entries()]
        .map(([p0, types]) => {
          const where = [...types].filter((t) => available.has(t)).sort();
          if (!where.length) return null;
          const planetsWith = where.map((t) => (typesHere.has(t) ? `${t}: ${typesHere.get(t)!.map((n) => n.split(" ").pop()).join(", ")}` : `${t} (what-if)`));
          return `${sde.typeName(p0)} -> ${planetsWith.join("; ")}`;
        })
        .filter((x): x is string => !!x)
        .sort();
      const missingP0 = [...pi.p0Planets.keys()].filter((p0) => ![...pi.p0Planets.get(p0)!].some((t) => available.has(t)))
        .map((p0) => p0WithPlanets(sde, pi, p0)).sort();

      // Single planet type chains: what one planet of each type here can make with no imports.
      const perPlanetType: Record<string, string> = {};
      for (const t of [...available].sort()) {
        const m = makeableByTier(pi, sde, [t], 2);
        perPlanetType[t] = Object.entries(m).map(([tier, list]) => `${tier}: ${Array.isArray(list) ? list.join(", ") : list}`).join(" | ") || "P1 only";
      }

      // Products not makeable here but one planet type away.
      const oneShort: string[] = [];
      for (const [id, t] of pi.tier) {
        if (t < 2 || !pi.schematic.has(id) || makeableOn(pi, id, available)) continue;
        const fixes = pi.planetTypes.filter((pt) => !available.has(pt) && makeableOn(pi, id, [...available, pt]));
        if (fixes.length) oneShort.push(`${sde.typeName(id)} (${tierName(t)}): add ${fixes.join(" or ")}`);
      }
      oneShort.sort();

      let charactersOut: CharacterPi[] | undefined;
      if (include_characters !== false) {
        const chars = characters?.length ? characters.map((r) => ctx.character(r)) : ctx.store.list();
        charactersOut = await mapLimit(chars, 4, (c) => characterPi(ctx, sde, c, systemId));
      }
      // Characters without Command Center Upgrades can only run a level 0 command center (1 extractor at most), so
      // list them by name instead of counting their slot as usable capacity.
      const untrained = charactersOut?.filter((c) => c.max_command_center_level === 0 && !c.colonies_total && !c.note).map((c) => c.character);
      const pilots = charactersOut
        ?.filter((c) => !untrained?.includes(c.character))
        .sort((a, b) => (b.colonies_here?.length ?? 0) - (a.colonies_here?.length ?? 0) || (b.free_slots ?? 0) - (a.free_slots ?? 0));
      const free = pilots?.reduce((n, c) => n + (c.free_slots ?? 0), 0);

      return reply({
        system: sde.systemSummary(systemId),
        planets: planetList,
        planet_types: Object.fromEntries([...typesHere].map(([t, ps]) => [t, ps.length])),
        what_if_planet_types: extra.length ? extra : undefined,
        p4_factory_possible: [...pi.highTech].some((t) => available.has(t))
          ? `yes (${[...pi.highTech].filter((t) => available.has(t)).join(", ")})`
          : `no: P4 needs a ${[...pi.highTech].join(" or ")} planet`,
        resources,
        resources_not_here: missingP0.length ? missingP0 : undefined,
        can_make_here: makeableByTier(pi, sde, available, 2),
        single_planet_chains: perPlanetType,
        one_planet_type_short: oneShort.length ? oneShort : undefined,
        characters: pilots,
        free_colony_slots_total: free,
        no_pi_skills: untrained?.length ? untrained : undefined,
        note: "Planets of the same type differ in resource abundance, which ESI does not expose. Scan in game before placing extractors.",
      });
    }),
  );

  server.registerTool(
    "pi_product",
    {
      title: "Planetary commodity chain",
      description:
        "How to make a planetary interaction (PI) commodity (P1-P4) and what it is for: tier, recipe and cycle, factory type, " +
        "raw resources (P0) with the planet types they come from, planet types that can make it alone, the smallest planet-type " +
        "combinations that can make it, the balanced factory chain (factories per step and P0 per hour for one top-level factory), " +
        "volume and customs tax base, and which PI products and industry groups use it. Accepts several products. " +
        "Use pi_system_planets to see what a system can make.",
      inputSchema: {
        products: z.array(z.string()).min(1).max(10).describe("Commodity names, e.g. ['Nano-Factory', 'Robotics', 'Coolant']."),
        tax_rate_pct: z.number().min(0).max(100).optional().describe("Customs office tax rate to price exports at (default 0, a corp POCO)."),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ products, tax_rate_pct }) => {
      const sde = await ctx.sde();
      const pi = piData(sde);
      const industry = usedInIndustry(sde, pi);
      const rate = (tax_rate_pct ?? 0) / 100;
      const out = products.map((ref) => {
        const id = typeRef(sde, ref);
        const t = pi.tier.get(id);
        if (t == null) throw new UserError(`${sde.typeName(id)} is not a planetary commodity.`);
        const type = sde.type(id)!;
        const taxBase = sde.attr(id, PI_ATTR.exportTaxBase);
        const raw = [...rawInputs(pi, id)];
        const base = {
          product: type.name,
          tier: tierName(t),
          volume: `${type.volume} m³`,
          customs_tax_base: isk(taxBase),
          export_tax_per_unit: rate && taxBase ? isk(taxBase * rate) : undefined,
          import_tax_per_unit: rate && taxBase ? isk(taxBase * rate * 0.5) : undefined,
          used_in_pi: (pi.usedIn.get(id) ?? []).map((o) => `${sde.typeName(o)} (${tierName(pi.tier.get(o))})`).sort(),
          used_in_industry: capList([...(industry.get(id) ?? [])].filter((g) => !/^Unpublished/.test(g)).sort(), 25),
        };
        if (t === 0) {
          return { ...base, found_on: [...(pi.p0Planets.get(id) ?? [])].sort(), extracted_by: "Extractor Control Unit" };
        }
        const sets = minimalPlanetSets(pi, id);
        const chain = balancedChain(pi, id);
        return {
          ...base,
          recipe: recipe(sde, pi, id),
          factory: factoryFor(pi, id),
          raw_materials: raw.map((r) => p0WithPlanets(sde, pi, r)).sort(),
          single_planet_types: pi.planetTypes.filter((p) => makeableOn(pi, id, [p])),
          fewest_planet_types: `${sets[0]?.length ?? "?"}: ${sets.slice(0, 8).map((s) => s.join(" + ")).join("; ")}${sets.length > 8 ? ` (+${sets.length - 8} more)` : ""}`,
          balanced_chain: [...chain.factories.entries()]
            .sort((a, b) => (pi.tier.get(b[0])! - pi.tier.get(a[0])!) || sde.typeName(a[0]).localeCompare(sde.typeName(b[0])))
            .map(([p, n]) => `${num(n)} x ${sde.typeName(p)} (${tierName(pi.tier.get(p))}, ${num(perHour(pi, p))}/h each)`),
          p0_per_hour: [...chain.p0PerHour.entries()].map(([p, n]) => `${sde.typeName(p)}: ${num(n)}/h`).sort(),
        };
      });
      return reply({ products: out });
    }),
  );
}
