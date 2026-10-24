import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Ctx } from "../context.js";
import type { StoredCharacter } from "../auth/store.js";
import { CATEGORY, type Sde } from "../sde/db.js";
import type { LocationInfo } from "../esi/resolver.js";
import { universePrices } from "../market.js";
import { chunk, isk, norm } from "../util.js";
import { READ_ONLY, characterParam, handler, reply } from "./helpers.js";

export interface Asset {
  item_id: number;
  type_id: number;
  quantity: number;
  location_id: number;
  location_type: string;
  location_flag: string;
  is_singleton: boolean;
  is_blueprint_copy?: boolean;
}

export interface AssetIndex {
  character: StoredCharacter;
  items: Asset[];
  byId: Map<number, Asset>;
  children: Map<number, Asset[]>;
  names: Map<number, string>;
  roots: Map<number, LocationInfo>;
  truncated: boolean;
}

/** Group ids of containers that can carry a custom name. */
const CONTAINER_GROUPS = new Set([12, 340, 448, 649, 1657, 1975]);

export function rootOf(index: Pick<AssetIndex, "byId">, a: Asset): Asset {
  let cur = a;
  for (let i = 0; i < 10; i++) {
    const parent = index.byId.get(cur.location_id);
    if (!parent) return cur;
    cur = parent;
  }
  return cur;
}

/** Loads all asset pages, custom ship/container names, and resolves every root location. */
export async function loadAssets(ctx: Ctx, c: StoredCharacter): Promise<AssetIndex> {
  const sde = await ctx.sde();
  const { items, truncated } = await ctx.esi.getAllPages<Asset>(`/characters/${c.id}/assets`, {
    character: c, scope: "esi-assets.read_assets.v1",
  });
  const byId = new Map(items.map((a) => [a.item_id, a]));
  const children = new Map<number, Asset[]>();
  for (const a of items) {
    if (byId.has(a.location_id)) {
      const l = children.get(a.location_id) ?? [];
      l.push(a);
      children.set(a.location_id, l);
    }
  }
  const nameable = items.filter((a) => {
    if (!a.is_singleton) return false;
    const t = sde.type(a.type_id);
    return t && (t.category_id === CATEGORY.ship || CONTAINER_GROUPS.has(t.group_id));
  });
  const names = new Map<number, string>();
  for (const part of chunk(nameable.map((a) => a.item_id), 1000)) {
    try {
      const res = await ctx.esi.post<Array<{ item_id: number; name: string }>>(`/characters/${c.id}/assets/names`, part, { character: c });
      for (const r of res) if (r.name && r.name !== "None") names.set(r.item_id, r.name);
    } catch { /* names are cosmetic */ }
  }
  const rootIds = new Set<number>();
  for (const a of items) rootIds.add(rootOf({ byId }, a).location_id);
  const roots = await ctx.resolver.locations(rootIds, c);
  return { character: c, items, byId, children, names, roots, truncated };
}

/** "Hangar > Ammo Can (Station Container) > ..." for an item. */
export function pathOf(sde: Sde, index: AssetIndex, a: Asset): string {
  const parts: string[] = [];
  let cur = a;
  for (let i = 0; i < 10; i++) {
    const parent = index.byId.get(cur.location_id);
    if (!parent) { parts.unshift(cur.location_flag); break; }
    parts.unshift(`${index.names.get(parent.item_id) ? `'${index.names.get(parent.item_id)}' ` : ""}${sde.typeName(parent.type_id)}${cur.location_flag !== "Unlocked" && cur.location_flag !== "Locked" ? ` [${cur.location_flag}]` : ""}`);
    cur = parent;
  }
  return parts.join(" > ");
}

function locationLabel(l: LocationInfo | undefined) {
  if (!l) return { location: "Unknown" };
  return {
    location: l.name,
    system: l.system?.name,
    security: l.system?.security,
    region: l.system?.region ?? undefined,
  };
}

export function registerAssetTools(server: McpServer, ctx: Ctx) {
  server.registerTool(
    "assets",
    {
      title: "Search and summarise assets",
      description:
        "A character's assets with names and locations resolved (stations, structures, containers, ships). Modes: " +
        "'summary' (per location: item count, estimated value, ships there), 'search' (find items by name/category, with location " +
        "and container path, plus totals per item), 'ships' (every assembled ship with its name and location). " +
        "Values use CCP's universe average price. ESI caches assets for up to an hour.",
      inputSchema: {
        character: characterParam,
        mode: z.enum(["summary", "search", "ships"]).optional().describe("Default: 'search' if a query/category is given, else 'summary'."),
        query: z.string().optional().describe("Item name to find (substring, case-insensitive; e.g. 'Gila', 'Hammerhead II', 'plex')."),
        category: z.string().optional().describe("Only this category (e.g. Ship, Module, Charge, Drone, Blueprint, Material, Planetary Commodities)."),
        location: z.string().optional().describe("Only assets whose station/structure/system/region contains this text."),
        limit: z.number().int().min(1).max(1000).optional().describe("Max rows (default 100)."),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ character, mode, query, category, location, limit }) => {
      const c = ctx.character(character);
      const sde = await ctx.sde();
      const index = await loadAssets(ctx, c);
      const prices = await universePrices(ctx).catch(() => new Map());
      const value = (a: Asset) => (a.is_blueprint_copy ? 0 : (prices.get(a.type_id)?.average ?? prices.get(a.type_id)?.adjusted ?? 0) * a.quantity);
      const max = limit ?? 100;
      const effectiveMode = mode ?? (query || category ? "search" : "summary");
      const catIds = category ? sde.categoryIdsByName(category) : null;
      const locFilter = location ? norm(location) : null;
      const q = query ? norm(query) : null;
      const locOk = (a: Asset) => {
        if (!locFilter) return true;
        const l = index.roots.get(rootOf(index, a).location_id);
        return !!l && [l.name, l.system?.name, l.system?.region].some((s) => s && norm(s).includes(locFilter));
      };

      if (effectiveMode === "summary") {
        const per = new Map<number, { stacks: number; units: number; value: number; ships: string[] }>();
        let total = 0;
        for (const a of index.items) {
          if (!locOk(a)) continue;
          const rootLoc = rootOf(index, a).location_id;
          const e = per.get(rootLoc) ?? { stacks: 0, units: 0, value: 0, ships: [] };
          e.stacks++;
          e.units += a.quantity;
          const v = value(a);
          e.value += v;
          total += v;
          if (a.is_singleton && sde.type(a.type_id)?.category_id === CATEGORY.ship && !index.byId.has(a.location_id)) {
            e.ships.push(`${sde.typeName(a.type_id)}${index.names.get(a.item_id) ? ` '${index.names.get(a.item_id)}'` : ""}`);
          }
          per.set(rootLoc, e);
        }
        const rows = [...per.entries()]
          .map(([id, e]) => ({ ...locationLabel(index.roots.get(id)), item_stacks: e.stacks, estimated_value: isk(e.value), ships: e.ships, _v: e.value }))
          .sort((a, b) => b._v - a._v)
          .slice(0, max)
          .map(({ _v, ...r }) => r);
        return reply({
          character: c.name,
          total_item_stacks: index.items.length,
          total_estimated_value: isk(total),
          locations: rows,
          truncated: index.truncated || undefined,
        });
      }

      if (effectiveMode === "ships") {
        const ships = index.items
          .filter((a) => a.is_singleton && sde.type(a.type_id)?.category_id === CATEGORY.ship && locOk(a))
          .filter((a) => !q || norm(sde.typeName(a.type_id)).includes(q) || norm(index.names.get(a.item_id) ?? "").includes(q))
          .slice(0, max)
          .map((a) => ({
            ship: sde.typeName(a.type_id),
            name: index.names.get(a.item_id),
            item_id: a.item_id,
            group: sde.type(a.type_id)?.group,
            ...locationLabel(index.roots.get(rootOf(index, a).location_id)),
            inside: index.byId.has(a.location_id) ? pathOf(sde, index, a) : undefined,
            fitted_modules: (index.children.get(a.item_id) ?? []).filter((x) => /Slot\d/.test(x.location_flag) && sde.type(x.type_id)?.category_id !== CATEGORY.charge).length,
          }));
        return reply({ character: c.name, count: ships.length, ships, hint: "Use ship_fitting with an item_id or name to get the full fit and EFT." });
      }

      const matches = index.items.filter((a) => {
        const t = sde.type(a.type_id);
        if (!t) return false;
        if (catIds?.length && !catIds.includes(t.category_id!)) return false;
        if (q && !norm(t.name).includes(q) && !norm(index.names.get(a.item_id) ?? "").includes(q) && !norm(t.group ?? "").includes(q)) return false;
        return locOk(a);
      });
      const totals = new Map<number, { units: number; value: number; locations: Set<string> }>();
      for (const a of matches) {
        const e = totals.get(a.type_id) ?? { units: 0, value: 0, locations: new Set() };
        e.units += a.quantity;
        e.value += value(a);
        e.locations.add(index.roots.get(rootOf(index, a).location_id)?.name ?? "Unknown");
        totals.set(a.type_id, e);
      }
      const rows = matches.slice(0, max).map((a) => ({
        item: sde.typeName(a.type_id),
        name: index.names.get(a.item_id),
        quantity: a.quantity,
        ...locationLabel(index.roots.get(rootOf(index, a).location_id)),
        path: pathOf(sde, index, a),
        blueprint_copy: a.is_blueprint_copy || undefined,
        item_id: a.item_id,
      }));
      return reply({
        character: c.name,
        matches: matches.length,
        totals_by_item: [...totals.entries()]
          .sort((a, b) => b[1].value - a[1].value)
          .slice(0, 50)
          .map(([id, e]) => ({ item: sde.typeName(id), units: e.units, estimated_value: isk(e.value), locations: [...e.locations] })),
        items: rows,
        truncated: matches.length > max ? `showing ${max} of ${matches.length}; narrow with location/category or raise limit` : undefined,
      });
    }),
  );
}

