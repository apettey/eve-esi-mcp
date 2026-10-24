import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Ctx } from "../context.js";
import { duration, isk, mapLimit, norm } from "../util.js";
import { READ_ONLY, characterParam, handler, reply, section } from "./helpers.js";

const ACTIVITIES: Record<number, string> = {
  1: "manufacturing",
  3: "time efficiency research",
  4: "material efficiency research",
  5: "copying",
  7: "reverse engineering",
  8: "invention",
  9: "reactions",
  11: "reactions",
};

export function registerIndustryTools(server: McpServer, ctx: Ctx) {
  server.registerTool(
    "industry",
    {
      title: "Industry jobs and blueprints",
      description:
        "A character's industry jobs (activity, blueprint, product, runs, facility, time left) and/or blueprints " +
        "(BPO/BPC, ME/TE, runs, location). Filter blueprints by name.",
      inputSchema: {
        character: characterParam,
        include: z.array(z.enum(["jobs", "blueprints"])).optional().describe("Default both."),
        include_completed_jobs: z.boolean().optional().describe("Include delivered/cancelled jobs (default false)."),
        blueprint_filter: z.string().optional().describe("Only blueprints whose name contains this text."),
        limit: z.number().int().min(1).max(500).optional().describe("Max blueprints (default 100)."),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ character, include, include_completed_jobs, blueprint_filter, limit }) => {
      const c = ctx.character(character);
      const sde = await ctx.sde();
      const want = new Set(include?.length ? include : ["jobs", "blueprints"]);
      const errors: Record<string, string> = {};
      const out: Record<string, unknown> = { character: c.name };
      if (want.has("jobs")) {
        out.jobs = await section(errors, "jobs", async () => {
          const jobs = await ctx.esi.get<any[]>(`/characters/${c.id}/industry/jobs`, {
            character: c, scope: "esi-industry.read_character_jobs.v1", query: { include_completed: !!include_completed_jobs },
          });
          const locs = await ctx.resolver.locations(jobs.map((j) => j.facility_id ?? j.station_id), c);
          const now = Date.now();
          return jobs
            .sort((a, b) => Date.parse(a.end_date) - Date.parse(b.end_date))
            .map((j) => {
              const left = Date.parse(j.end_date) - now;
              return {
                activity: ACTIVITIES[j.activity_id] ?? `activity ${j.activity_id}`,
                blueprint: sde.typeName(j.blueprint_type_id),
                product: j.product_type_id ? sde.typeName(j.product_type_id) : undefined,
                runs: j.runs,
                status: j.status === "active" && left <= 0 ? "ready" : j.status,
                time_left: j.status === "active" ? duration(left) : undefined,
                ends: j.end_date,
                facility: locs.get(j.facility_id ?? j.station_id)?.name,
                cost: j.cost ? isk(j.cost) : undefined,
                probability: j.probability,
              };
            });
        });
      }
      if (want.has("blueprints")) {
        out.blueprints = await section(errors, "blueprints", async () => {
          const { items } = await ctx.esi.getAllPages<any>(`/characters/${c.id}/blueprints`, {
            character: c, scope: "esi-characters.read_blueprints.v1",
          });
          const f = blueprint_filter ? norm(blueprint_filter) : null;
          const filtered = items.filter((b) => !f || norm(sde.typeName(b.type_id)).includes(f));
          // Blueprints inside containers/ships report that item as location; only hangar entries point at a station or structure.
          const inHangar = (b: any) => b.location_flag === "Hangar" || b.location_flag === "Deliveries";
          const locs = await ctx.resolver.locations(filtered.filter(inHangar).map((b) => b.location_id), c);
          return {
            total: filtered.length,
            list: filtered.slice(0, limit ?? 100).map((b) => ({
              name: sde.typeName(b.type_id),
              kind: b.quantity === -2 ? "BPC" : "BPO",
              me: b.material_efficiency,
              te: b.time_efficiency,
              runs: b.runs === -1 ? "unlimited" : b.runs,
              stack: b.quantity > 0 ? b.quantity : undefined,
              location: inHangar(b) ? locs.get(b.location_id)?.name : `inside item ${b.location_id} (${b.location_flag}); see assets`,
            })),
          };
        });
      }
      if (Object.keys(errors).length) out.unavailable = errors;
      return reply(out);
    }),
  );

  server.registerTool(
    "planets",
    {
      title: "Planetary industry colonies",
      description:
        "A character's PI colonies with planet names and types, extractor products and expiry times (soonest first), factory " +
        "schematics, and storage contents. ESI only updates PI data when the colony is viewed in game.",
      inputSchema: {
        character: characterParam,
        include_storage: z.boolean().optional().describe("Include storage/launchpad contents (default true)."),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ character, include_storage }) => {
      const c = ctx.character(character);
      const sde = await ctx.sde();
      const scope = "esi-planets.manage_planets.v1";
      const colonies = await ctx.esi.get<any[]>(`/characters/${c.id}/planets`, { character: c, scope });
      const now = Date.now();
      const details = await mapLimit(colonies, 6, async (p) => {
        const d = await ctx.esi.get<any>(`/characters/${c.id}/planets/${p.planet_id}`, { character: c }).catch(() => null);
        const pins = d?.pins ?? [];
        const extractors = pins.filter((x: any) => x.extractor_details).map((x: any) => {
          const exp = x.expiry_time ? Date.parse(x.expiry_time) : null;
          return {
            product: x.extractor_details.product_type_id ? sde.typeName(x.extractor_details.product_type_id) : "not configured",
            expires: x.expiry_time,
            status: exp == null ? "idle" : exp <= now ? "EXPIRED" : `${duration(exp - now)} left`,
            heads: x.extractor_details.heads?.length,
            cycle_minutes: x.extractor_details.cycle_time ? Math.round(x.extractor_details.cycle_time / 60) : undefined,
            _exp: exp ?? 0,
          };
        });
        const factories = new Map<string, number>();
        const storage = new Map<number, number>();
        for (const pin of pins) {
          if (pin.schematic_id || pin.factory_details) {
            const sid = pin.schematic_id ?? pin.factory_details?.schematic_id;
            const key = sid ? `schematic ${sid}` : sde.typeName(pin.type_id);
            factories.set(key, (factories.get(key) ?? 0) + 1);
          }
          for (const ct of pin.contents ?? []) storage.set(ct.type_id, (storage.get(ct.type_id) ?? 0) + ct.amount);
        }
        // Schematic names come from the output product of the factory's schematic.
        const schematicNames = await Promise.all(
          [...factories.keys()].map(async (k) => {
            const sid = Number(k.replace("schematic ", ""));
            if (!sid) return [k, factories.get(k)!] as const;
            const s = await ctx.esi.get<any>(`/universe/schematics/${sid}`).catch(() => null);
            return [s?.schematic_name ?? k, factories.get(k)!] as const;
          }),
        );
        const soonest = extractors.filter((e: any) => e._exp).sort((a: any, b: any) => a._exp - b._exp)[0];
        return {
          planet: sde.planetName(p.planet_id) ?? `Planet ${p.planet_id}`,
          type: p.planet_type,
          system: sde.systemSummary(p.solar_system_id)?.name,
          security: sde.systemSummary(p.solar_system_id)?.security,
          command_center_level: p.upgrade_level,
          pins: p.num_pins,
          last_update: p.last_update,
          extractors: extractors.map(({ _exp, ...e }: any) => e),
          factories: schematicNames.map(([n, count]) => `${n} x${count}`),
          storage: include_storage === false ? undefined : [...storage.entries()].map(([id, n]) => `${sde.typeName(id)} x${n}`),
          _soonest: soonest?._exp ?? Infinity,
        };
      });
      details.sort((a, b) => a._soonest - b._soonest);
      return reply({
        character: c.name,
        colonies: details.length,
        expired_extractors: details.flatMap((d) => d.extractors.filter((e: any) => e.status === "EXPIRED").map(() => d.planet)),
        planets: details.map(({ _soonest, ...d }) => d),
      });
    }),
  );
}
