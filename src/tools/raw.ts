import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Ctx } from "../context.js";
import { UserError } from "../util.js";
import { characterParam, handler, reply } from "./helpers.js";
import { systemRef, typeRef } from "./universe.js";

export function registerRawTools(server: McpServer, ctx: Ctx) {
  server.registerTool(
    "esi_request",
    {
      title: "Raw ESI request",
      description:
        "Escape hatch for any ESI route not covered by a dedicated tool (see https://developers.eveonline.com/api-explorer). " +
        "Paths may use {character_id}, {corporation_id} and {alliance_id}, filled from the selected character. Authentication, " +
        "compatibility date, caching and pagination are handled; id fields in the response get *_name siblings. " +
        "Non-GET methods change game state: confirm with the user first.",
      inputSchema: {
        path: z.string().describe("e.g. /characters/{character_id}/standings or /corporations/{corporation_id}/structures"),
        method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional(),
        query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        body: z.unknown().optional().describe("JSON body for POST/PUT."),
        all_pages: z.boolean().optional().describe("Fetch every X-Pages page (default true for GET)."),
        resolve_names: z.boolean().optional().describe("Add *_name fields for ids (default true)."),
        authenticated: z.boolean().optional().describe("Send the character's token (default: when the path contains a placeholder or /characters|corporations|fleets/)."),
        character: characterParam,
      },
      annotations: { openWorldHint: true },
    },
    handler(async ({ path, method, query, body, all_pages, resolve_names, authenticated, character }) => {
      if (!path.startsWith("/")) throw new UserError("path must start with '/'");
      const m = method ?? "GET";
      const needsChar = authenticated ?? (/\{(character|corporation|alliance)_id\}/.test(path) || /^\/(characters|corporations|corporation|fleets|ui|alliances\/\d+\/contacts)/.test(path));
      const c = needsChar ? ctx.character(character) : ctx.maybeCharacter(character);
      let p = path;
      if (/\{(corporation|alliance)_id\}/.test(p)) {
        if (!c) throw new UserError("A character is required to fill {corporation_id}/{alliance_id}.");
        const pub = await ctx.esi.get<any>(`/characters/${c.id}`);
        p = p.replace("{corporation_id}", String(pub.corporation_id));
        if (p.includes("{alliance_id}")) {
          if (!pub.alliance_id) throw new UserError(`${c.name} is not in an alliance.`);
          p = p.replace("{alliance_id}", String(pub.alliance_id));
        }
      }
      if (c) p = p.replace("{character_id}", String(c.id));
      if (/\{[a-z_]+\}/.test(p)) throw new UserError(`Unfilled path parameter in ${p}`);
      const opts = { character: needsChar ? c : undefined, query };
      let data: unknown;
      let pages: number | undefined;
      if (m === "GET" && all_pages !== false) {
        const res = await ctx.esi.request<unknown>("GET", p, opts);
        if (res.pages > 1 && Array.isArray(res.data)) {
          const all = await ctx.esi.getAllPages<unknown>(p, opts);
          data = all.items;
          pages = all.pages;
        } else data = res.data;
      } else {
        data = (await ctx.esi.request<unknown>(m, p, { ...opts, body })).data;
      }
      if (resolve_names !== false && data && typeof data === "object") data = await ctx.resolver.enrich(data, c);
      return reply({ path: p, method: m, pages, data: data ?? "(no content)" });
    }),
  );

  server.registerTool(
    "ui_action",
    {
      title: "Control the EVE client",
      description:
        "Acts on the running EVE client of the character (must be logged in to the game): set autopilot destination or add a waypoint " +
        "(system, NPC station or structure), open the market window for an item, or open the show-info window for an item/character/" +
        "corporation/alliance.",
      inputSchema: {
        action: z.enum(["set_destination", "add_waypoint", "open_market", "open_info"]),
        target: z.union([z.string(), z.number()]).describe("System/station name or id, structure id, item name, or entity name/id."),
        character: characterParam,
      },
      annotations: { openWorldHint: true },
    },
    handler(async ({ action, target, character }) => {
      const c = ctx.character(character);
      const sde = await ctx.sde();
      if (action === "set_destination" || action === "add_waypoint") {
        let dest: number;
        const asNum = Number(target);
        if (Number.isInteger(asNum) && (asNum >= 1e12 || sde.station(asNum) || sde.system(asNum))) dest = asNum;
        else {
          const station = sde.searchStations(String(target), 1)[0];
          dest = sde.systemIdByName(String(target)) ?? station ?? systemRef(sde, String(target));
        }
        await ctx.esi.request("POST", "/ui/autopilot/waypoint", {
          character: c, scope: "esi-ui.write_waypoint.v1",
          query: { destination_id: dest, add_to_beginning: false, clear_other_waypoints: action === "set_destination" },
        });
        const label = sde.station(dest)?.name ?? sde.system(dest)?.name ?? (await ctx.resolver.location(dest, c)).name;
        return reply({ done: action, target: label, character: c.name });
      }
      if (action === "open_market") {
        const typeId = typeRef(sde, target);
        await ctx.esi.request("POST", "/ui/openwindow/marketdetails", { character: c, scope: "esi-ui.open_window.v1", query: { type_id: typeId } });
        return reply({ done: action, item: sde.typeName(typeId), character: c.name });
      }
      let id = Number(target);
      if (!Number.isInteger(id)) {
        const typeId = sde.typeIdByName(String(target));
        if (typeId) id = typeId;
        else {
          const res = await ctx.esi.post<Record<string, Array<{ id: number }>>>("/universe/ids", [String(target)]);
          const hit = res.characters?.[0] ?? res.corporations?.[0] ?? res.alliances?.[0];
          if (!hit) throw new UserError(`Nothing named "${target}".`);
          id = hit.id;
        }
      }
      await ctx.esi.request("POST", "/ui/openwindow/information", { character: c, scope: "esi-ui.open_window.v1", query: { target_id: id } });
      return reply({ done: action, target_id: id, character: c.name });
    }),
  );
}
