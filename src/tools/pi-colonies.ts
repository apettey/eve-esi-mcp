import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Ctx } from "../context.js";
import type { StoredCharacter } from "../auth/store.js";
import { piData, tierName } from "../pi.js";
import { analyzeColony } from "../pi-colony.js";
import { duration, mapLimit } from "../util.js";
import { READ_ONLY, characterParam, handler, reply } from "./helpers.js";

const SCOPE = "esi-planets.manage_planets.v1";

const n0 = (n: number) => Math.round(n).toLocaleString("en-US");

export function registerPiColonyTools(server: McpServer, ctx: Ctx) {
  server.registerTool(
    "planets",
    {
      title: "Planetary industry colonies (all characters)",
      description:
        "Status of PI colonies across every logged-in character (or one, with `character`): an attention list first (expired or " +
        "soon-expiring extractors, storage filling up, idle factories, factories short of input), then each colony with " +
        "its extractors (product, heads, time left, output now and averaged over the program from the decay curve), " +
        "factories, what the planet makes per day after its own factories, input shortfalls, storage fill and time until " +
        "full. ESI only refreshes a colony when it is opened in game, so `data_age` says how old each one is. " +
        "Use pi_optimize to plan colonies.",
      inputSchema: {
        character: characterParam,
        characters: z.array(z.string()).max(50).optional().describe("Several characters (default: every logged-in character)."),
        system: z.string().optional().describe("Only colonies in this system, e.g. 'J163701'."),
        include_storage: z.boolean().optional().describe("List storage contents per colony (default false)."),
        warn_hours: z.number().min(1).max(336).optional().describe("Flag extractors ending and storage filling within this many hours (default 24)."),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ character, characters, system, include_storage, warn_hours }) => {
      const sde = await ctx.sde();
      const pi = piData(sde);
      const now = Date.now();
      const warnMs = (warn_hours ?? 24) * 3_600_000;
      const chars: StoredCharacter[] = character
        ? [ctx.character(character)]
        : characters?.length
          ? characters.map((r) => ctx.character(r))
          : ctx.store.list();
      if (!chars.length) ctx.character(); // throws the "log in first" error
      const systemId = system ? (sde.systemIdByName(system) ?? Number(system)) : null;

      const unavailable: Record<string, string> = {};
      const attention: Array<{ at: number; text: string }> = [];
      const perChar = await mapLimit(chars, 3, async (c) => {
        let colonies: any[];
        try {
          colonies = await ctx.esi.get<any[]>(`/characters/${c.id}/planets`, { character: c, scope: SCOPE });
        } catch (err) {
          unavailable[c.name] = (err as Error).message;
          return [];
        }
        if (systemId) colonies = colonies.filter((p) => p.solar_system_id === systemId);
        return mapLimit(colonies, 4, async (p) => {
          const layout = await ctx.esi.get<any>(`/characters/${c.id}/planets/${p.planet_id}`, { character: c, scope: SCOPE });
          const a = analyzeColony(sde, pi, layout, now);
          const where = `${c.name}: ${sde.planetName(p.planet_id) ?? `Planet ${p.planet_id}`}`;
          // Issues on this colony; only the most urgent goes to the attention list (rank, then time).
          const issues: Array<{ rank: number; at: number; text: string }> = [];

          const extractors = a.extractors.map((e) => {
            const left = e.expiryMs != null ? e.expiryMs - now : null;
            const status = left == null ? "not running" : left <= 0 ? `EXPIRED ${duration(-left)} ago` : `${duration(left)} left`;
            if (left == null || left <= 0) issues.push({ rank: 0, at: left ?? -Infinity, text: `${sde.typeName(e.product)} extractor ${status}` });
            else if (left < warnMs) issues.push({ rank: 1, at: left, text: `${sde.typeName(e.product)} extractor ends in ${duration(left)}` });
            return {
              product: e.product ? sde.typeName(e.product) : "not configured",
              heads: e.heads,
              status,
              cycle: e.cycleSeconds ? duration(e.cycleSeconds * 1000) : undefined,
              qty_per_cycle: e.qtyPerCycle || undefined,
              per_hour_now: e.program && left != null && left > 0 ? n0(e.program.nowPerHour) : undefined,
              per_hour_program_avg: e.program ? n0(e.program.avgPerHour) : undefined,
              program_total: e.program ? n0(e.program.total) : undefined,
              remaining: e.program && left != null && left > 0 ? n0(e.program.remaining) : undefined,
            };
          });

          const factories = [...a.factories].map(([product, count]) => {
            const idle = a.idleFactories.get(product) ?? 0;
            if (idle) issues.push({ rank: 3, at: 0, text: `${idle} of ${count} ${sde.typeName(product)} factories idle (no inputs for over 2 cycles)` });
            return `${sde.typeName(product)} (${tierName(pi.tier.get(product))}) x${count}${idle ? ` (${idle} idle)` : ""}`;
          });

          const shortfalls = a.shortfalls.map((s) => {
            const text = `${sde.typeName(s.type)}: factories need ${n0(s.need)}/h, the planet makes ${n0(s.have)}/h (${Math.round((s.have / s.need) * 100)}%)`;
            // Shortfalls on a planet that imports by design are normal; only flag ones with no stock to cover a day.
            if ((a.contents.get(s.type) ?? 0) < (s.need - s.have) * 24) issues.push({ rank: 4, at: 0, text: `short of ${text}` });
            return text;
          });

          const net = [...a.made]
            .map(([type, rate]) => [type, rate - Math.min(rate, a.used.get(type) ?? 0)] as const)
            .filter(([, r]) => r > 0.01)
            .map(([type, r]) => `${sde.typeName(type)} (${tierName(pi.tier.get(type))}) ${n0(r * 24)}/day`);

          let storage: string | undefined;
          if (a.capacityM3) {
            const free = Math.max(0, a.capacityM3 - a.storedM3);
            const fullIn = a.surplusM3PerHour > 0 ? (free / a.surplusM3PerHour) * 3_600_000 : null;
            storage = `${n0(a.storedM3)} / ${n0(a.capacityM3)} m³` + (fullIn != null ? `, full in ~${duration(fullIn)} if nothing is launched` : "");
            if (fullIn != null && fullIn < warnMs) issues.push({ rank: 2, at: fullIn, text: `storage full in ~${duration(fullIn)}` });
          }
          if (issues.length) {
            issues.sort((x, y) => x.rank - y.rank || x.at - y.at);
            // Several extractors with the same status read as one line.
            const top = issues[0];
            const same = issues.filter((i) => i.text === top.text).length;
            const others = new Set(issues.filter((i) => i.text !== top.text).map((i) => i.text)).size;
            attention.push({
              at: top.rank * 1e15 + top.at,
              text: `${where}: ${same > 1 ? `${same} x ` : ""}${top.text}${others ? ` (+${others} more below)` : ""}`,
            });
          }

          const soonest = Math.min(...a.extractors.map((e) => (e.expiryMs ?? now) - now), Infinity);
          const updated = p.last_update ? Date.parse(p.last_update) : null;
          return {
            _soonest: soonest,
            character: c.name,
            planet: sde.planetName(p.planet_id) ?? `Planet ${p.planet_id}`,
            type: p.planet_type,
            system: sde.systemSummary(p.solar_system_id)?.name,
            command_center_level: p.upgrade_level,
            pins: p.num_pins,
            data_age: updated ? `${duration(now - updated)} (as of last time the colony was opened in game)` : undefined,
            extractors,
            factories,
            makes_per_day: net,
            shortfalls,
            storage,
            contents: include_storage ? [...a.contents].map(([t, n]) => `${sde.typeName(t)} x${n0(n)}`) : undefined,
          };
        });
      });

      const planets = perChar.flat().sort((x, y) => x._soonest - y._soonest).map(({ _soonest, ...rest }) => rest);
      attention.sort((x, y) => x.at - y.at);
      const byChar = new Map<string, number>();
      for (const p of planets) byChar.set(p.character, (byChar.get(p.character) ?? 0) + 1);
      return reply({
        characters_with_colonies: [...byChar].map(([n, k]) => `${n} (${k})`),
        colonies: planets.length,
        attention: attention.length ? attention.map((x) => x.text) : ["nothing needs attention"],
        planets,
        unavailable: Object.keys(unavailable).length ? unavailable : undefined,
        note: planets.length && planets.some((p) => p.extractors.length)
          ? "Extractor output uses ESI's qty_per_cycle with the community decay curve (not an official formula)."
          : undefined,
      });
    }),
  );
}
