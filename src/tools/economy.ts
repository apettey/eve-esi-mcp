import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Ctx } from "../context.js";
import { appraise, parseItemList, resolveMarketScope } from "../market.js";
import { duration, isk, mapLimit, round, unique } from "../util.js";
import { READ_ONLY, characterParam, handler, reply, section } from "./helpers.js";

const humanize = (s: string) => s.replace(/_/g, " ");

export function registerEconomyTools(server: McpServer, ctx: Ctx) {
  server.registerTool(
    "wallet",
    {
      title: "Wallet, journal and transactions",
      description:
        "A character's ISK balance, income/expense breakdown by type over recent days, latest journal entries (with party names) and " +
        "latest market transactions (item, quantity, price, location, counterparty).",
      inputSchema: {
        character: characterParam,
        days: z.number().int().min(1).max(30).optional().describe("Window for the income/expense summary (default 30; ESI keeps 30 days)."),
        journal_limit: z.number().int().min(0).max(500).optional().describe("Journal entries to list (default 20)."),
        transactions_limit: z.number().int().min(0).max(500).optional().describe("Market transactions to list (default 20)."),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ character, days, journal_limit, transactions_limit }) => {
      const c = ctx.character(character);
      const sde = await ctx.sde();
      const scope = "esi-wallet.read_character_wallet.v1";
      const [balance, journal, transactions] = await Promise.all([
        ctx.esi.get<number>(`/characters/${c.id}/wallet`, { character: c, scope }),
        ctx.esi.getAllPages<any>(`/characters/${c.id}/wallet/journal`, { character: c, scope }, 20),
        ctx.esi.get<any[]>(`/characters/${c.id}/wallet/transactions`, { character: c, scope }),
      ]);
      const since = Date.now() - (days ?? 30) * 86400_000;
      const byType = new Map<string, { income: number; expense: number; count: number }>();
      let income = 0, expense = 0;
      for (const j of journal.items) {
        if (Date.parse(j.date) < since || j.amount == null) continue;
        const e = byType.get(j.ref_type) ?? { income: 0, expense: 0, count: 0 };
        if (j.amount >= 0) { e.income += j.amount; income += j.amount; } else { e.expense += j.amount; expense += j.amount; }
        e.count++;
        byType.set(j.ref_type, e);
      }
      const jl = journal.items.sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, journal_limit ?? 20);
      const tl = transactions.sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, transactions_limit ?? 20);
      const names = await ctx.resolver.entities([
        ...jl.flatMap((j) => [j.first_party_id, j.second_party_id]),
        ...tl.map((t) => t.client_id),
      ].filter(Boolean));
      const locs = await ctx.resolver.locations(tl.map((t) => t.location_id), c);
      return reply({
        character: c.name,
        balance: isk(balance),
        balance_raw: balance,
        summary: {
          days: days ?? 30,
          income: isk(income),
          expense: isk(expense),
          net: isk(income + expense),
          by_type: [...byType.entries()]
            .sort((a, b) => Math.abs(b[1].income + b[1].expense) - Math.abs(a[1].income + a[1].expense))
            .map(([t, e]) => ({ type: humanize(t), net: isk(e.income + e.expense), income: e.income ? isk(e.income) : undefined, expense: e.expense ? isk(e.expense) : undefined, entries: e.count })),
        },
        journal: jl.map((j) => ({
          date: j.date,
          type: humanize(j.ref_type),
          amount: isk(j.amount),
          balance: isk(j.balance),
          from: names.get(j.first_party_id)?.name,
          to: names.get(j.second_party_id)?.name,
          description: j.description,
          reason: j.reason || undefined,
        })),
        transactions: tl.map((t) => ({
          date: t.date,
          side: t.is_buy ? "bought" : "sold",
          item: sde.typeName(t.type_id),
          quantity: t.quantity,
          unit_price: isk(t.unit_price),
          total: isk(t.unit_price * t.quantity),
          location: locs.get(t.location_id)?.name,
          counterparty: names.get(t.client_id)?.name,
        })),
      });
    }),
  );

  server.registerTool(
    "market_orders",
    {
      title: "Character market orders",
      description:
        "A character's open market orders with item and location names, remaining volume, expiry and escrow — and whether each order " +
        "is currently the best price at its station or has been undercut/outbid (and by how much). Optionally recent order history.",
      inputSchema: {
        character: characterParam,
        check_competition: z.boolean().optional().describe("Compare against the live order book (default true; one ESI call per item type)."),
        include_history: z.boolean().optional().describe("Also list recently closed orders (default false)."),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ character, check_competition, include_history }) => {
      const c = ctx.character(character);
      const sde = await ctx.sde();
      const scope = "esi-markets.read_character_orders.v1";
      const orders = await ctx.esi.get<any[]>(`/characters/${c.id}/orders`, { character: c, scope });
      const locs = await ctx.resolver.locations(orders.map((o) => o.location_id), c);
      const books = new Map<string, any[]>();
      if (check_competition !== false) {
        const keys = unique(orders.map((o) => `${o.location_id >= 1e12 ? `s${o.location_id}` : o.region_id}:${o.type_id}`));
        await mapLimit(keys.slice(0, 40), 6, async (k) => {
          const [where, typeId] = k.split(":");
          try {
            if (where.startsWith("s")) {
              if (!c.scopes.includes("esi-markets.structure_markets.v1")) return;
              const all = await ctx.esi.getAllPages<any>(`/markets/structures/${where.slice(1)}`, { character: c });
              books.set(k, all.items.filter((o) => o.type_id === Number(typeId)));
            } else {
              const all = await ctx.esi.getAllPages<any>(`/markets/${where}/orders`, { query: { order_type: "all", type_id: Number(typeId) } });
              books.set(k, all.items);
            }
          } catch { /* competition is best-effort */ }
        });
      }
      const mine = new Set(orders.map((o) => o.order_id));
      let sellValue = 0, escrow = 0;
      const rows = orders.map((o) => {
        const isBuy = !!o.is_buy_order;
        if (isBuy) escrow += o.escrow ?? 0; else sellValue += o.price * o.volume_remain;
        const book = books.get(`${o.location_id >= 1e12 ? `s${o.location_id}` : o.region_id}:${o.type_id}`);
        let competition: string | undefined;
        if (book) {
          const rivals = book.filter((x) => !mine.has(x.order_id) && x.is_buy_order === isBuy && x.location_id === o.location_id);
          const best = isBuy ? Math.max(...rivals.map((x) => x.price)) : Math.min(...rivals.map((x) => x.price));
          if (!rivals.length) competition = "no competing orders at this location";
          else if (isBuy ? best > o.price : best < o.price) competition = `${isBuy ? "outbid" : "undercut"}: best rival ${isk(best)} (${round(((best - o.price) / o.price) * 100, 2)}%)`;
          else competition = `best price (next rival ${isk(best)})`;
        }
        const expires = Date.parse(o.issued) + o.duration * 86400_000;
        return {
          order_id: o.order_id,
          side: isBuy ? "buy" : "sell",
          item: sde.typeName(o.type_id),
          price: isk(o.price),
          volume: `${o.volume_remain}/${o.volume_total}`,
          location: locs.get(o.location_id)?.name,
          range: isBuy ? o.range : undefined,
          expires_in: duration(expires - Date.now()),
          escrow: o.escrow ? isk(o.escrow) : undefined,
          corporation_order: o.is_corporation || undefined,
          competition,
        };
      });
      const errors: Record<string, string> = {};
      const history = include_history
        ? await section(errors, "history", async () => {
            const h = await ctx.esi.getAllPages<any>(`/characters/${c.id}/orders/history`, { character: c, scope }, 3);
            return h.items.slice(0, 50).map((o) => ({
              side: o.is_buy_order ? "buy" : "sell", item: sde.typeName(o.type_id), price: isk(o.price),
              filled: `${o.volume_total - o.volume_remain}/${o.volume_total}`, state: o.state, issued: o.issued,
            }));
          })
        : undefined;
      return reply({
        character: c.name,
        open_orders: rows.length,
        sell_orders_value: isk(sellValue),
        buy_orders_escrow: isk(escrow),
        orders: rows,
        history,
        errors: Object.keys(errors).length ? errors : undefined,
      });
    }),
  );

  server.registerTool(
    "appraise",
    {
      title: "Appraise a list of items",
      description:
        "Values free-form item text at a market (default Jita 4-4): EFT fits, in-game inventory/cargo copy-paste (tab separated), " +
        "'Item x10', '10 Item' lines. Returns per-item buy/sell unit and totals, volume, and unrecognized lines. " +
        "Items with no sell (or buy) orders at the market are named in the totals, with an estimate using the universe average.",
      inputSchema: {
        text: z.string().describe("The item list or EFT fit."),
        location: z.string().optional().describe("Market location (default 'jita')."),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ text, location }) => {
      const sde = await ctx.sde();
      const lines = parseItemList(sde, text);
      const scope = await resolveMarketScope(ctx, location);
      return reply(await appraise(ctx, lines, scope));
    }),
  );

  server.registerTool(
    "contracts",
    {
      title: "Character contracts",
      description:
        "A character's contracts (issued to/by them) with names for issuer/assignee/acceptor, start/end locations, prices, courier " +
        "details and the items in each item-exchange/auction contract.",
      inputSchema: {
        character: characterParam,
        status: z.enum(["active", "finished", "all"]).optional().describe("active = outstanding/in progress (default)."),
        type: z.enum(["item_exchange", "auction", "courier", "any"]).optional(),
        include_items: z.boolean().optional().describe("Fetch item lists (default true, up to 25 contracts)."),
        limit: z.number().int().min(1).max(200).optional().describe("Max contracts (default 50)."),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ character, status, type, include_items, limit }) => {
      const c = ctx.character(character);
      const sde = await ctx.sde();
      const scope = "esi-contracts.read_character_contracts.v1";
      const { items } = await ctx.esi.getAllPages<any>(`/characters/${c.id}/contracts`, { character: c, scope }, 10);
      const active = new Set(["outstanding", "in_progress"]);
      const list = items
        .filter((x) => (status ?? "active") === "all" || ((status ?? "active") === "active" ? active.has(x.status) : !active.has(x.status)))
        .filter((x) => !type || type === "any" || x.type === type)
        .sort((a, b) => Date.parse(b.date_issued) - Date.parse(a.date_issued))
        .slice(0, limit ?? 50);
      const names = await ctx.resolver.entities(list.flatMap((x) => [x.issuer_id, x.assignee_id, x.acceptor_id]).filter(Boolean));
      const locs = await ctx.resolver.locations(list.flatMap((x) => [x.start_location_id, x.end_location_id]).filter(Boolean), c);
      const withItems = include_items === false ? [] : list.filter((x) => x.type !== "courier").slice(0, 25);
      const itemMap = new Map<number, any[]>();
      await mapLimit(withItems, 6, async (x) => {
        const its = await ctx.esi.get<any[]>(`/characters/${c.id}/contracts/${x.contract_id}/items`, { character: c }).catch(() => null);
        if (its) itemMap.set(x.contract_id, its);
      });
      return reply({
        character: c.name,
        count: list.length,
        contracts: list.map((x) => ({
          contract_id: x.contract_id,
          type: x.type,
          status: x.status,
          title: x.title || undefined,
          direction: x.issuer_id === c.id ? "issued by me" : x.assignee_id === c.id ? "assigned to me" : "other",
          issuer: names.get(x.issuer_id)?.name,
          assignee: names.get(x.assignee_id)?.name,
          acceptor: x.acceptor_id ? names.get(x.acceptor_id)?.name : undefined,
          availability: x.availability,
          price: x.price ? isk(x.price) : undefined,
          reward: x.reward ? isk(x.reward) : undefined,
          collateral: x.collateral ? isk(x.collateral) : undefined,
          buyout: x.buyout ? isk(x.buyout) : undefined,
          volume_m3: x.volume || undefined,
          start: locs.get(x.start_location_id)?.name,
          end: x.end_location_id !== x.start_location_id ? locs.get(x.end_location_id)?.name : undefined,
          issued: x.date_issued,
          expires: x.date_expired,
          days_to_complete: x.type === "courier" ? x.days_to_complete : undefined,
          items: itemMap.get(x.contract_id)?.map((i) => ({
            item: sde.typeName(i.type_id),
            quantity: i.quantity,
            ...(i.is_included ? {} : { requested: true }),
            ...(i.raw_quantity === -2 ? { blueprint_copy: true } : {}),
          })),
        })),
      });
    }),
  );
}
