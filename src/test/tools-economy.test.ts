import assert from "node:assert/strict";
import { callTool, character, sde, testCtx, withSde } from "./harness.js";

const PILOT = character(90000101, "Wallet Pilot");
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

withSde("wallet summarises income by type and names parties, items and locations", async () => {
  const tritanium = sde!.typeIdByName("Tritanium")!;
  const ctx = testCtx({
    characters: [PILOT],
    esi: {
      [`/characters/${PILOT.id}/wallet`]: 1_234_567_890.5,
      [`/characters/${PILOT.id}/wallet/journal`]: [
        { id: 1, date: hoursAgo(1), ref_type: "bounty_prizes", amount: 5_000_000, balance: 1_234_567_890.5, first_party_id: 1000125, second_party_id: PILOT.id },
        { id: 2, date: hoursAgo(2), ref_type: "market_transaction", amount: -2_000_000, balance: 1_229_567_890.5, first_party_id: PILOT.id, second_party_id: 90000999 },
        { id: 3, date: hoursAgo(24 * 40), ref_type: "bounty_prizes", amount: 99_000_000, balance: 1, first_party_id: 1000125, second_party_id: PILOT.id },
      ],
      [`/characters/${PILOT.id}/wallet/transactions`]: [
        { transaction_id: 7, date: hoursAgo(2), is_buy: true, type_id: tritanium, quantity: 1000, unit_price: 2000, location_id: 60003760, client_id: 90000999 },
      ],
      "POST /universe/names": [
        { id: 1000125, name: "CONCORD", category: "corporation" },
        { id: PILOT.id, name: PILOT.name, category: "character" },
        { id: 90000999, name: "Some Trader", category: "character" },
      ],
    },
  });
  const r = await callTool(ctx, "wallet", { days: 7 });
  assert.equal(r.isError, false, r.text);
  const w = r.json;
  assert.equal(w.character, "Wallet Pilot");
  assert.equal(w.balance, "1.23b ISK");
  assert.equal(w.balance_raw, 1_234_567_890.5);
  assert.equal(w.summary.income, "5.00m ISK", "entries outside the window are left out of the summary");
  assert.equal(w.summary.net, "3.00m ISK");
  assert.equal(w.journal[0].from, "CONCORD");
  assert.equal(w.journal[1].to, "Some Trader");
  const t = w.transactions[0];
  assert.deepEqual(
    { side: t.side, item: t.item, total: t.total, counterparty: t.counterparty },
    { side: "bought", item: "Tritanium", total: "2.00m ISK", counterparty: "Some Trader" },
  );
  assert.match(t.location, /^Jita IV - Moon 4/);
});

withSde("appraise names items with no sell orders instead of silently leaving them out of the sell total", async () => {
  const thanatos = sde!.typeIdByName("Thanatos")!;
  const dc = sde!.typeIdByName("Damage Control II")!;
  const JITA_44 = 60003760;
  const order = (type_id: number, is_buy_order: boolean, price: number) =>
    ({ type_id, is_buy_order, price, volume_remain: 5, location_id: JITA_44 });
  const ctx = testCtx({
    esi: {
      "/markets/prices": [{ type_id: thanatos, average_price: 2_000_000_000 }, { type_id: dc, average_price: 900_000 }],
      "/markets/10000002/orders": (req: any) =>
        [order(thanatos, true, 2_100_000_000), order(dc, false, 1_000_000), order(dc, true, 800_000)]
          .filter((o) => o.type_id === req.query.type_id),
    },
  });
  const r = await callTool(ctx, "appraise", { text: "Thanatos\t1\tCarrier\tShip\nDamage Control II x2" });
  assert.equal(r.isError, false, r.text);
  const t = r.json.totals;
  assert.equal(t.sell, 2_000_000, "the sell total only sums items that have sell orders");
  assert.deepEqual(t.no_sell_orders, ["Thanatos"]);
  assert.equal(t.no_buy_orders, undefined);
  assert.equal(t.sell_estimate_isk, "2.00b ISK", "the estimate fills gaps with the universe average");
  assert.match(t.note, /Thanatos/);
  assert.equal(t.buy_isk, "2.10b ISK");
  assert.equal(r.json.items.find((i: any) => i.name === "Thanatos").sell_total, undefined);
});
