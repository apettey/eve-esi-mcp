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
