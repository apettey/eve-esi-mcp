import { TRADE_HUBS } from "./config.js";
import type { Ctx } from "./context.js";
import { resolveTypeName } from "./fit/model.js";
import type { Sde } from "./sde/db.js";
import { UserError, isk, mapLimit, norm, round } from "./util.js";

export interface MarketScope {
  label: string;
  regionId: number;
  stationId?: number;
  systemId?: number;
  structureId?: number;
}

/** Turns "jita", a station/structure/system/region name or id into a market scope. Defaults to Jita 4-4. */
export async function resolveMarketScope(ctx: Ctx, location?: string | null): Promise<MarketScope> {
  const sde = await ctx.sde();
  const loc = (location ?? "jita").trim();
  const hub = TRADE_HUBS[norm(loc)];
  if (hub) return { label: sde.station(hub.stationId)?.name ?? hub.name, regionId: hub.regionId, stationId: hub.stationId };
  const asNum = Number(loc);
  if (Number.isInteger(asNum) && asNum >= 1e12) {
    const character = ctx.character();
    ctx.esi.requireScope(character, "esi-markets.structure_markets.v1");
    const s = await ctx.resolver.structure(asNum, character);
    const sys = s.system_id ? sde.system(s.system_id) : null;
    return { label: s.name, regionId: sys?.region_id ?? 0, structureId: asNum };
  }
  const regionId = sde.regionIdByName(loc) ?? (Number.isInteger(asNum) && asNum >= 10000000 && asNum < 11000000 ? asNum : null);
  if (regionId) return { label: `${sde.regionName(regionId)} (region)`, regionId };
  const systemId = sde.systemIdByName(loc);
  if (systemId) {
    const s = sde.system(systemId)!;
    return { label: `${s.name} (system)`, regionId: s.region_id, systemId };
  }
  const stations = sde.searchStations(loc, 2);
  if (stations.length) {
    const st = sde.station(stations[0])!;
    return { label: st.name, regionId: sde.system(st.system_id)!.region_id, stationId: st.id };
  }
  throw new UserError(
    `Unknown market location "${loc}". Use a trade hub (jita, amarr, dodixie, rens, hek), a region, system or station name, or a structure id.`,
  );
}

interface Order {
  is_buy_order: boolean;
  price: number;
  volume_remain: number;
  location_id: number;
  system_id?: number;
  type_id: number;
  min_volume?: number;
}

/** PLEX trades on a single universe-wide market. */
const PLEX = 44992;
const PLEX_REGION = 19000001;

async function ordersFor(ctx: Ctx, scope: MarketScope, typeId: number): Promise<Order[]> {
  if (typeId === PLEX) {
    const { items } = await ctx.esi.getAllPages<Order>(`/markets/${PLEX_REGION}/orders`, { query: { order_type: "all", type_id: typeId } });
    return items;
  }
  if (scope.structureId) {
    const character = ctx.character();
    const { items } = await ctx.esi.getAllPages<Order>(`/markets/structures/${scope.structureId}`, { character });
    return items.filter((o) => o.type_id === typeId);
  }
  const { items } = await ctx.esi.getAllPages<Order>(`/markets/${scope.regionId}/orders`, {
    query: { order_type: "all", type_id: typeId },
  });
  return items.filter(
    (o) => (!scope.stationId || o.location_id === scope.stationId) && (!scope.systemId || o.system_id === scope.systemId),
  );
}

export async function marketSummary(ctx: Ctx, scope: MarketScope, typeId: number, opts: { history?: boolean; depth?: number } = {}) {
  const orders = await ordersFor(ctx, scope, typeId);
  const sells = orders.filter((o) => !o.is_buy_order).sort((a, b) => a.price - b.price);
  const buys = orders.filter((o) => o.is_buy_order).sort((a, b) => b.price - a.price);
  const vol = (l: Order[]) => l.reduce((s, o) => s + o.volume_remain, 0);
  const sell = sells[0]?.price ?? null;
  const buy = buys[0]?.price ?? null;
  const depth = opts.depth ?? 0;
  const out: Record<string, unknown> = {
    sell_min: sell,
    buy_max: buy,
    sell_min_isk: isk(sell),
    buy_max_isk: isk(buy),
    spread_percent: sell && buy ? round(((sell - buy) / sell) * 100, 2) : null,
    sell_orders: sells.length,
    buy_orders: buys.length,
    sell_volume: vol(sells),
    buy_volume: vol(buys),
  };
  if (depth > 0) {
    out.sell_book = sells.slice(0, depth).map((o) => ({ price: o.price, volume: o.volume_remain }));
    out.buy_book = buys.slice(0, depth).map((o) => ({ price: o.price, volume: o.volume_remain }));
  }
  if (typeId === PLEX) out.note = "PLEX uses one global market; prices are universe-wide, not location specific.";
  if (opts.history && scope.regionId) {
    try {
      const hist = await ctx.esi.get<Array<{ date: string; average: number; volume: number; order_count: number; highest: number; lowest: number }>>(
        `/markets/${typeId === PLEX ? PLEX_REGION : scope.regionId}/history`, { query: { type_id: typeId } },
      );
      if (!hist.length) throw new Error("no trades");
      const last30 = hist.slice(-30);
      const last7 = hist.slice(-7);
      const avg = (l: typeof hist, f: (h: (typeof hist)[0]) => number) => (l.length ? l.reduce((s, h) => s + f(h), 0) / l.length : null);
      out.region_history = {
        days: last30.length,
        avg_price_7d: round(avg(last7, (h) => h.average) ?? 0, 2),
        avg_price_30d: round(avg(last30, (h) => h.average) ?? 0, 2),
        avg_daily_volume_7d: Math.round(avg(last7, (h) => h.volume) ?? 0),
        avg_daily_volume_30d: Math.round(avg(last30, (h) => h.volume) ?? 0),
        last_day: hist.at(-1) ?? null,
      };
    } catch {
      out.region_history = null;
    }
  }
  return out;
}

let pricesCache: { at: number; map: Map<number, { adjusted?: number; average?: number }> } | undefined;

/** CCP's universe-wide adjusted/average prices (used for industry costs and rough valuations). */
export async function universePrices(ctx: Ctx) {
  if (pricesCache && Date.now() - pricesCache.at < 3600_000) return pricesCache.map;
  const rows = await ctx.esi.get<Array<{ type_id: number; adjusted_price?: number; average_price?: number }>>("/markets/prices");
  pricesCache = { at: Date.now(), map: new Map(rows.map((r) => [r.type_id, { adjusted: r.adjusted_price, average: r.average_price }])) };
  return pricesCache.map;
}

export interface ParsedLine {
  input: string;
  name: string;
  quantity: number;
  type_id: number | null;
}

/**
 * Parses free-form item lists: EFT fits, in-game inventory copy (tab separated), "Name x10",
 * "10 Name", "10x Name", and contract/cargo scan lines.
 */
export function parseItemList(sde: Sde, text: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  const num = (s: string) => Number(s.replace(/[,\s.](?=\d{3}\b)/g, "").replace(/,/g, ""));
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (!line || /^\[empty .* slot\]$/i.test(line)) continue;
    const header = /^\[(.+?),.*\]$/.exec(line);
    if (header) { out.push(mk(sde, line, header[1], 1)); continue; }
    if (line.includes("\t")) {
      const cols = line.split("\t").map((c) => c.trim());
      const q = cols.slice(1).find((c) => /^[\d,.\s]+$/.test(c) && c !== "");
      out.push(mk(sde, line, cols[0], q ? num(q) : 1));
      continue;
    }
    let m = /^(.*?)\s+x\s?([\d,.]+)$/i.exec(line);
    if (m) { out.push(mk(sde, line, m[1], num(m[2]))); continue; }
    m = /^([\d,.]+)\s*x?\s+(.+)$/i.exec(line);
    if (m) { out.push(mk(sde, line, m[2], num(m[1]))); continue; }
    const parts = line.split(/,\s*/);
    if (parts.length === 2 && resolveTypeName(sde, parts[0]) && resolveTypeName(sde, parts[1])) {
      out.push(mk(sde, line, parts[0], 1));
      out.push(mk(sde, line, parts[1], 1));
      continue;
    }
    out.push(mk(sde, line, line.replace(/\s*\/offline$/i, ""), 1));
  }
  return out;
}

function mk(sde: Sde, input: string, name: string, quantity: number): ParsedLine {
  const n = name.trim();
  return { input, name: n, quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1, type_id: resolveTypeName(sde, n) };
}

export async function appraise(ctx: Ctx, lines: ParsedLine[], scope: MarketScope) {
  const sde = await ctx.sde();
  const merged = new Map<number, number>();
  const unknown: string[] = [];
  for (const l of lines) {
    if (l.type_id == null) unknown.push(l.name);
    else merged.set(l.type_id, (merged.get(l.type_id) ?? 0) + l.quantity);
  }
  const prices = await universePrices(ctx);
  const ids = [...merged.keys()];
  const summaries = await mapLimit(ids, 8, (id) => marketSummary(ctx, scope, id).catch(() => null));
  let sellTotal = 0, buyTotal = 0, volume = 0;
  const items = ids.map((id, i) => {
    const qty = merged.get(id)!;
    const s = summaries[i] as any;
    const t = sde.type(id)!;
    const sell = s?.sell_min ?? null;
    const buy = s?.buy_max ?? null;
    sellTotal += (sell ?? 0) * qty;
    buyTotal += (buy ?? 0) * qty;
    volume += (t.packaged_volume ?? t.volume ?? 0) * qty;
    return {
      name: t.name,
      quantity: qty,
      sell_unit: sell,
      buy_unit: buy,
      sell_total: sell != null ? round(sell * qty, 2) : null,
      buy_total: buy != null ? round(buy * qty, 2) : null,
      universe_average: prices.get(id)?.average ?? null,
      volume_m3: round((t.packaged_volume ?? t.volume ?? 0) * qty, 2),
    };
  });
  items.sort((a, b) => (b.sell_total ?? 0) - (a.sell_total ?? 0));
  return {
    market: scope.label,
    totals: {
      sell: round(sellTotal, 2),
      buy: round(buyTotal, 2),
      sell_isk: isk(sellTotal),
      buy_isk: isk(buyTotal),
      volume_m3: round(volume, 2),
      item_types: items.length,
    },
    items,
    ...(unknown.length ? { unrecognized: unknown } : {}),
  };
}
