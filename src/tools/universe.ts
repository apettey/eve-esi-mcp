import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Ctx } from "../context.js";
import { TRADE_HUBS } from "../config.js";
import { CATEGORY, type Sde } from "../sde/db.js";
import { describeShipBonuses, moduleAttributes } from "../fit/render.js";
import { resolveTypeName } from "../fit/model.js";
import { loadSkills, describeRequirements, requirementClosure, skillGaps, type CharacterSkills } from "../skills.js";
import { marketSummary, resolveMarketScope } from "../market.js";
import { UserError, mapLimit, round } from "../util.js";
import { READ_ONLY, characterParam, handler, reply, section } from "./helpers.js";

/** Resolves a type reference (id or name, fuzzy) or throws with suggestions. */
export function typeRef(sde: Sde, ref: string | number): number {
  const asNum = Number(ref);
  if (Number.isInteger(asNum) && asNum > 0 && sde.type(asNum)) return asNum;
  const exact = resolveTypeName(sde, String(ref));
  if (exact) return exact;
  const hits = sde.searchTypes(String(ref), { limit: 5 });
  if (hits.length === 1 || (hits.length && hits[0].score >= 550 && (hits[1]?.score ?? 0) < hits[0].score - 50)) return hits[0].id;
  throw new UserError(
    hits.length
      ? `"${ref}" is ambiguous. Did you mean: ${hits.map((h) => sde.typeName(h.id)).join(", ")}?`
      : `No item named "${ref}". Try search_items.`,
  );
}

/** Resolves a solar system by id or name (exact, then partial). */
export function systemRef(sde: Sde, ref: string | number): number {
  const asNum = Number(ref);
  if (Number.isInteger(asNum) && sde.system(asNum)) return asNum;
  const exact = sde.systemIdByName(String(ref));
  if (exact) return exact;
  const hits = sde.searchSystems(String(ref), 5);
  if (hits.length === 1) return hits[0];
  throw new UserError(
    hits.length
      ? `System "${ref}" is ambiguous: ${hits.map((h) => sde.system(h)!.name).join(", ")}.`
      : `Unknown solar system "${ref}".`,
  );
}

async function optionalSkills(ctx: Ctx, ref?: string, wanted = true): Promise<{ skills?: CharacterSkills; name?: string; note?: string }> {
  if (!wanted) return {};
  const c = ctx.maybeCharacter(ref);
  if (!c) return {};
  if (!c.scopes.includes("esi-skills.read_skills.v1")) return { note: `${c.name} has not granted esi-skills.read_skills.v1` };
  try {
    return { skills: await loadSkills(ctx.esi, c), name: c.name };
  } catch (err) {
    return { note: (err as Error).message };
  }
}

function blueprintDetails(sde: Sde, bpId: number) {
  const bp = sde.blueprint(bpId);
  if (!bp) return null;
  const acts: Record<string, unknown> = {};
  for (const [activity, a] of Object.entries<any>(bp.activities)) {
    acts[activity] = {
      time: `${a.time}s`,
      materials: a.materials?.map((m: any) => ({ name: sde.typeName(m.typeID), quantity: m.quantity })),
      products: a.products?.map((p: any) => ({ name: sde.typeName(p.typeID), quantity: p.quantity, ...(p.probability ? { probability: p.probability } : {}) })),
      skills: a.skills?.map((s: any) => `${sde.typeName(s.typeID)} ${s.level}`),
    };
  }
  return { blueprint: sde.typeName(bpId), max_runs_per_copy: bp.max_runs, activities: acts };
}

export function registerUniverseTools(server: McpServer, ctx: Ctx) {
  server.registerTool(
    "search_items",
    {
      title: "Search items by name",
      description:
        "Fuzzy search over every published EVE item (ships, modules, ammo, materials, skills, ...) using the local static data. " +
        "Accepts several queries at once and common shorthand (mwd, dc, lse, scram, web, ...). Blueprints/SKINs are hidden unless asked for. " +
        "Use item_info for full details on a match.",
      inputSchema: {
        queries: z.union([z.string(), z.array(z.string()).max(25)]).describe("One query or a list of queries."),
        category: z.string().optional().describe("Filter by category name, e.g. Ship, Module, Charge, Drone, Skill, Implant, Material."),
        group: z.string().optional().describe("Filter by group name, e.g. 'Frigate', 'Shield Extender', 'Hybrid Charge'."),
        meta_group: z.string().optional().describe("Filter by meta group: 'Tech I', 'Tech II', 'Faction', 'Deadspace', 'Officer', 'Storyline', 'Tech III'."),
        limit: z.number().int().min(1).max(50).optional().describe("Max matches per query (default 8)."),
        with_prices: z.boolean().optional().describe("Add Jita 4-4 best buy/sell for each match (extra ESI calls)."),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ queries, category, group, meta_group, limit, with_prices }) => {
      const sde = await ctx.sde();
      const qs = Array.isArray(queries) ? queries : [queries];
      const categoryIds = category ? sde.categoryIdsByName(category) : undefined;
      const groupIds = group ? sde.groupIdsByName(group) : undefined;
      const metaGroupIds = meta_group ? sde.metaGroupIdsByName(meta_group) : undefined;
      if (category && !categoryIds?.length) throw new UserError(`Unknown category "${category}".`);
      if (group && !groupIds?.length) throw new UserError(`Unknown group "${group}".`);
      const scope = with_prices ? await resolveMarketScope(ctx, "jita") : null;
      const results = await mapLimit(qs, 4, async (q) => {
        const hits = sde.searchTypes(q, { categoryIds, groupIds, metaGroupIds, limit: limit ?? 8 });
        const matches = await mapLimit(hits, 6, async (h) => {
          const t = sde.type(h.id)!;
          const m = scope ? ((await marketSummary(ctx, scope, h.id).catch(() => null)) as any) : null;
          return {
            name: t.name,
            type_id: t.id,
            category: t.category,
            group: t.group,
            meta_group: t.meta_group ?? undefined,
            slot: t.slot ?? undefined,
            volume_m3: t.packaged_volume ?? t.volume ?? undefined,
            ...(m ? { jita_sell: m.sell_min_isk, jita_buy: m.buy_max_isk } : {}),
          };
        });
        return { query: q, matches };
      });
      return reply(qs.length === 1 ? results[0] : { results });
    }),
  );

  server.registerTool(
    "item_info",
    {
      title: "Item details",
      description:
        "Everything about one or more items in one call: category/group, meta level, volume, description, formatted attributes " +
        "(grouped, with units), required skills (checked against the character if logged in, with training time for gaps), " +
        "ship bonuses, variants (T1/T2/faction/...), manufacturing blueprint materials, and optionally Jita prices.",
      inputSchema: {
        items: z.array(z.union([z.string(), z.number()])).min(1).max(10).describe("Item names (fuzzy) or type ids."),
        attributes: z.enum(["none", "summary", "full"]).optional().describe("Attribute detail (default summary)."),
        include_market: z.boolean().optional().describe("Include Jita 4-4 order book summary and 30d history."),
        include_description: z.boolean().optional().describe("Include the item description (default true)."),
        character: characterParam,
      },
      annotations: READ_ONLY,
    },
    handler(async ({ items, attributes, include_market, include_description, character }) => {
      const sde = await ctx.sde();
      const ids = items.map((i) => typeRef(sde, i));
      const sk = await optionalSkills(ctx, character);
      const scope = include_market ? await resolveMarketScope(ctx, "jita") : null;
      const out = await mapLimit(ids, 4, async (id) => {
        const t = sde.type(id)!;
        const closure = requirementClosure(sde, [id]);
        const producers = sde.blueprintsProducing(id).filter((p) => p.activity === "manufacturing" || p.activity === "reaction");
        const errors: Record<string, string> = {};
        const market = scope ? await section(errors, "market", () => marketSummary(ctx, scope, id, { history: true })) : undefined;
        return {
          name: t.name,
          type_id: id,
          category: t.category,
          group: t.group,
          market_group: sde.marketGroupPath(t.market_group_id),
          meta_group: t.meta_group,
          meta_level: t.meta_level,
          tech_level: t.tech_level,
          slot: t.slot,
          hardpoint: t.hardpoint,
          volume_m3: t.volume,
          packaged_volume_m3: t.packaged_volume !== t.volume ? t.packaged_volume : undefined,
          capacity_m3: t.capacity || undefined,
          mass_kg: t.category_id === CATEGORY.ship ? t.mass : undefined,
          base_price: t.base_price || undefined,
          published: !!t.published,
          description: include_description === false ? undefined : t.description?.replace(/<[^>]+>/g, ""),
          required_skills: describeRequirements(sde, id, sk.skills),
          skill_check: sk.skills
            ? { character: sk.name, ...skillGaps(sde, closure, sk.skills) }
            : sk.note ? { note: sk.note } : undefined,
          bonuses: t.category_id === CATEGORY.ship || t.category_id === CATEGORY.subsystem ? describeShipBonuses(sde, id) : undefined,
          attributes: moduleAttributes(sde, id, attributes ?? "summary"),
          variations: sde.variations(id).filter((v) => v !== id).map((v) => {
            const vt = sde.type(v)!;
            return `${vt.name} (${vt.meta_group ?? "?"})`;
          }),
          blueprint: t.category_id === CATEGORY.blueprint ? blueprintDetails(sde, id) : undefined,
          manufactured_from: producers.length ? producers.map((p) => blueprintDetails(sde, p.blueprint_id)) : undefined,
          market: market ? { location: scope!.label, ...market } : undefined,
          errors: Object.keys(errors).length ? errors : undefined,
        };
      });
      return reply(ids.length === 1 ? out[0] : { items: out });
    }),
  );

  server.registerTool(
    "lookup",
    {
      title: "Resolve names and ids",
      description:
        "Resolves names or ids of characters, corporations, alliances, factions, systems, regions, constellations, stations and items " +
        "to their counterpart, with public details (corp/alliance of a character, ticker/members of a corp, security of a system, ...).",
      inputSchema: {
        names: z.array(z.string()).max(50).optional().describe("Exact names (case-insensitive) to resolve."),
        ids: z.array(z.number().int()).max(100).optional().describe("Ids to resolve."),
        details: z.boolean().optional().describe("Fetch public details for characters/corporations/alliances (default true)."),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ names, ids, details }) => {
      const sde = await ctx.sde();
      const found: Array<Record<string, unknown>> = [];
      const unresolved: string[] = [];
      const esiNames: string[] = [];
      for (const n of names ?? []) {
        const typeId = sde.typeIdByName(n);
        const sys = sde.systemIdByName(n);
        const reg = sde.regionIdByName(n);
        const con = sde.constellationIdByName(n);
        if (sys) found.push({ query: n, category: "solar_system", id: sys, ...sde.systemSummary(sys) });
        else if (reg) found.push({ query: n, category: "region", id: reg, name: sde.regionName(reg) });
        else if (con) found.push({ query: n, category: "constellation", id: con, name: sde.constellationName(con) });
        if (typeId) found.push({ query: n, category: "inventory_type", id: typeId, name: sde.typeName(typeId), group: sde.type(typeId)?.group });
        esiNames.push(n);
      }
      const people: Array<{ id: number; category: string; name: string; query?: string }> = [];
      if (esiNames.length) {
        const res = await ctx.esi.post<Record<string, Array<{ id: number; name: string }>>>("/universe/ids", esiNames);
        const cats: Record<string, string> = { characters: "character", corporations: "corporation", alliances: "alliance", agents: "agent", factions: "faction", stations: "station" };
        // /universe/ids can return near-matches (e.g. by ticker); keep exact name matches only.
        const wanted = new Map(esiNames.map((n) => [n.toLowerCase(), n]));
        for (const [k, cat] of Object.entries(cats)) for (const e of res[k] ?? []) {
          const q = wanted.get(e.name.toLowerCase());
          if (q) people.push({ ...e, category: cat, query: q });
        }
        const all = new Set([...found.map((f) => String(f.query).toLowerCase()), ...people.map((p) => p.name.toLowerCase())]);
        for (const n of esiNames) if (!all.has(n.toLowerCase())) unresolved.push(n);
      }
      if (ids?.length) {
        const typeIds = ids.filter((id) => id < 500000 && sde.type(id));
        for (const id of typeIds) found.push({ category: "inventory_type", id, name: sde.typeName(id), group: sde.type(id)?.group });
        const ents = await ctx.resolver.entities(ids.filter((id) => !typeIds.includes(id)));
        for (const id of ids) {
          if (typeIds.includes(id)) continue;
          const e = ents.get(id);
          if (!e) { unresolved.push(String(id)); continue; }
          if (["character", "corporation", "alliance", "agent", "faction"].includes(e.category)) people.push(e);
          else if (e.category === "solar_system") found.push({ category: e.category, ...sde.systemSummary(id) });
          else found.push({ ...e });
        }
      }
      const detailed = await mapLimit(people, 6, async (p) => {
        if (details === false) return p;
        try {
          if (p.category === "character") {
            const c = await ctx.esi.get<any>(`/characters/${p.id}`);
            const n = await ctx.resolver.entities([c.corporation_id, c.alliance_id].filter(Boolean));
            return {
              ...p, corporation: n.get(c.corporation_id)?.name, alliance: c.alliance_id ? n.get(c.alliance_id)?.name : undefined,
              birthday: c.birthday, security_status: c.security_status != null ? round(c.security_status, 2) : undefined, gender: c.gender,
            };
          }
          if (p.category === "corporation") {
            const c = await ctx.esi.get<any>(`/corporations/${p.id}`);
            const n = await ctx.resolver.entities([c.ceo_id, c.alliance_id, c.faction_id].filter(Boolean));
            return {
              ...p, ticker: c.ticker, members: c.member_count, ceo: n.get(c.ceo_id)?.name, alliance: c.alliance_id ? n.get(c.alliance_id)?.name : undefined,
              faction: c.faction_id ? n.get(c.faction_id)?.name : undefined, tax_rate: c.tax_rate, founded: c.date_founded, url: c.url || undefined,
              war_eligible: c.war_eligible,
            };
          }
          if (p.category === "alliance") {
            const a = await ctx.esi.get<any>(`/alliances/${p.id}`);
            const corps = await ctx.esi.get<number[]>(`/alliances/${p.id}/corporations`).catch(() => []);
            return { ...p, ticker: a.ticker, executor: await ctx.resolver.entityName(a.executor_corporation_id), founded: a.date_founded, corporations: corps.length };
          }
        } catch { /* details are best-effort */ }
        return p;
      });
      return reply({ results: [...found, ...detailed], unresolved: unresolved.length ? unresolved : undefined });
    }),
  );

  server.registerTool(
    "system_info",
    {
      title: "Solar system details",
      description:
        "Details for a solar system: security, constellation/region, NPC stations, gate neighbours with security, sovereignty, " +
        "ship/pod/NPC kills and jumps in the last hour, and jump distance to the major trade hubs. Use 'current' for the character's location. " +
        "For wormhole (J-space) systems: class, system effect with its modifiers, and static wormholes with destination, mass and lifetime.",
      inputSchema: {
        system: z.string().describe("System name or id, or 'current' for the character's current system."),
        character: characterParam,
      },
      annotations: READ_ONLY,
    },
    handler(async ({ system, character }) => {
      const sde = await ctx.sde();
      let id: number;
      if (system.toLowerCase() === "current") {
        const c = ctx.character(character);
        const loc = await ctx.esi.get<any>(`/characters/${c.id}/location`, { character: c, scope: "esi-location.read_location.v1" });
        id = loc.solar_system_id;
      } else id = systemRef(sde, system);
      const errors: Record<string, string> = {};
      const [kills, jumps, sov] = await Promise.all([
        section(errors, "kills", () => ctx.esi.get<any[]>("/universe/system_kills")),
        section(errors, "jumps", () => ctx.esi.get<any[]>("/universe/system_jumps")),
        section(errors, "sovereignty", () => ctx.esi.get<any>("/sovereignty/systems")),
      ]);
      const k = kills?.find((x) => x.system_id === id);
      const j = jumps?.find((x) => x.system_id === id);
      const sovEntry = sov?.solar_systems?.find((x: any) => x.solar_system_id === id);
      // claim is one of {faction: {...}}, {alliance: {...}} or {unclaimed: true}.
      const sovOwner = sovEntry?.claim ? await ctx.resolver.enrich(sovEntry.claim) : undefined;
      // J-space has no stargates, so neighbours and gate distances only apply to known space.
      const wormhole = sde.wormholeSystem(id);
      const dist = wormhole ? null : sde.jumpDistances(id, 60);
      return reply({
        ...sde.systemSummary(id),
        wormhole: wormhole ?? undefined,
        stations: sde.stationsInSystem(id).map((s) => s.name),
        neighbours: wormhole ? undefined : sde.neighbours(id).map((n) => {
          const s = sde.systemSummary(n)!;
          return `${s.name} (${s.security}${s.region !== sde.systemSummary(id)!.region ? `, ${s.region}` : ""})`;
        }),
        sovereignty: sovOwner,
        last_hour: { ship_kills: k?.ship_kills ?? 0, pod_kills: k?.pod_kills ?? 0, npc_kills: k?.npc_kills ?? 0, jumps: j?.ship_jumps ?? 0 },
        jumps_to_trade_hubs: dist ? Object.fromEntries(
          Object.entries(TRADE_HUBS).map(([hub, h]) => [hub, dist.get(h.systemId) ?? ">60 or unreachable by gates"]),
        ) : undefined,
        errors: Object.keys(errors).length ? errors : undefined,
      });
    }),
  );

  server.registerTool(
    "wormhole_type",
    {
      title: "Wormhole type lookup",
      description:
        "Looks up wormhole types by their signature code (e.g. K162, H296, D845): destination class, max mass per jump, total mass, " +
        "mass regeneration, lifetime, and the classes of systems that have it as a static.",
      inputSchema: {
        codes: z.array(z.string()).min(1).max(20).describe("Wormhole codes, e.g. ['H296', 'K162']."),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ codes }) => {
      const sde = await ctx.sde();
      const out = codes.map((c) => sde.wormholeType(c) ?? { code: c, error: `Unknown wormhole type "${c}".` });
      return reply(out.length === 1 ? out[0] : { wormholes: out });
    }),
  );

  server.registerTool(
    "route_plan",
    {
      title: "Plan a route",
      description:
        "Plans a stargate route and returns every system with security and region, a security breakdown, and recent kills along the way. " +
        "Origin defaults to the character's current system. Optionally sets the in-game autopilot destination " +
        "(set_destination changes the game client: confirm with the user first).",
      inputSchema: {
        to: z.string().describe("Destination system (name or id)."),
        from: z.string().optional().describe("Origin system; defaults to the character's current location."),
        preference: z.enum(["shortest", "secure", "insecure"]).optional().describe("Route preference (default shortest)."),
        avoid: z.array(z.string()).optional().describe("Systems to avoid."),
        set_destination: z.boolean().optional().describe("Also set the in-game autopilot destination (needs esi-ui.write_waypoint.v1)."),
        character: characterParam,
      },
      annotations: { openWorldHint: true },
    },
    handler(async ({ to, from, preference, avoid, set_destination, character }) => {
      const sde = await ctx.sde();
      const dest = systemRef(sde, to);
      let origin: number;
      if (from) origin = systemRef(sde, from);
      else {
        const c = ctx.character(character);
        origin = (await ctx.esi.get<any>(`/characters/${c.id}/location`, { character: c, scope: "esi-location.read_location.v1" })).solar_system_id;
      }
      const pref = { shortest: "Shorter", secure: "Safer", insecure: "LessSecure" }[preference ?? "shortest"];
      const body = { preference: pref, avoid_systems: (avoid ?? []).map((a) => systemRef(sde, a)) };
      const route = await ctx.esi.post<{ route: number[] }>(`/route/${origin}/${dest}`, body);
      const kills = await ctx.esi.get<any[]>("/universe/system_kills").catch(() => []);
      const killMap = new Map(kills.map((k) => [k.system_id, k]));
      const systems = route.route.map((id) => {
        const s = sde.systemSummary(id)!;
        const k = killMap.get(id);
        return { name: s.name, security: s.security, region: s.region, kills: k ? k.ship_kills + k.pod_kills : 0 };
      });
      const bands = route.route.reduce((acc: Record<string, number>, id) => {
        const b = sde.systemSummary(id)!.security_band;
        acc[b] = (acc[b] ?? 0) + 1;
        return acc;
      }, {});
      let destinationSet: string | undefined;
      if (set_destination) {
        const c = ctx.character(character);
        await ctx.esi.request("POST", "/ui/autopilot/waypoint", {
          character: c, scope: "esi-ui.write_waypoint.v1",
          query: { destination_id: dest, add_to_beginning: false, clear_other_waypoints: true },
        });
        destinationSet = `Autopilot destination set for ${c.name}`;
      }
      return reply({
        from: sde.system(origin)?.name,
        to: sde.system(dest)?.name,
        preference: preference ?? "shortest",
        jumps: Math.max(0, route.route.length - 1),
        security_breakdown: bands,
        lowest_security: Math.min(...systems.map((s) => s.security)),
        regions: [...new Set(systems.map((s) => s.region))],
        hot_systems: systems.filter((s) => s.kills >= 3).map((s) => `${s.name} (${s.kills} ship+pod kills last hour)`),
        // "System (security) [region on change] {kills}" keeps long routes compact.
        systems: systems.map((s, i) =>
          `${s.name} (${s.security})${i === 0 || systems[i - 1].region !== s.region ? ` [${s.region}]` : ""}${s.kills ? ` {${s.kills} kills/h}` : ""}`,
        ),
        destination_set: destinationSet,
      });
    }),
  );

  server.registerTool(
    "market_prices",
    {
      title: "Market prices",
      description:
        "Best buy/sell, spread, order counts and volumes for up to 20 items at a market (default Jita 4-4; also amarr, dodixie, rens, hek, " +
        "any region/system/station name, or a structure id), with optional 7/30-day regional history and order book depth.",
      inputSchema: {
        items: z.array(z.union([z.string(), z.number()])).min(1).max(20).describe("Item names (fuzzy) or type ids."),
        location: z.string().optional().describe("Market location (default 'jita')."),
        history: z.boolean().optional().describe("Include regional 7d/30d price & volume averages (default true)."),
        depth: z.number().int().min(0).max(20).optional().describe("Number of order book levels per side to include (default 0)."),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ items, location, history, depth }) => {
      const sde = await ctx.sde();
      const scope = await resolveMarketScope(ctx, location);
      const ids = items.map((i) => typeRef(sde, i));
      const rows = await mapLimit(ids, 6, async (id) => ({
        name: sde.typeName(id),
        type_id: id,
        ...(await marketSummary(ctx, scope, id, { history: history !== false, depth })),
      }));
      return reply({ market: scope.label, items: rows });
    }),
  );

  server.registerTool(
    "server_status",
    {
      title: "Tranquility status",
      description: "EVE server status (players online, version, start time) and the SDE/static data build this server is using.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    handler(async () => {
      const status = await ctx.esi.get<any>("/status", { fresh: true }).catch((e) => ({ error: (e as Error).message }));
      return reply({ tranquility: status, static_data: ctx.sdeManager.status() });
    }),
  );
}
