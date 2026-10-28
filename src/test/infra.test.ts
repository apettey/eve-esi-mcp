// Building blocks every tool relies on: the character store, reply/handler/section, util helpers, scope presets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CharacterStore } from "../auth/store.js";
import { FULL_SCOPES, READONLY_SCOPES, STANDARD_SCOPES } from "../auth/scopes.js";
import { errorReply, handler, reply, section } from "../tools/helpers.js";
import { UserError, chunk, duration, isk, mapLimit, stripHtml } from "../util.js";
import { character, esiError } from "./harness.js";

const tempHome = () => mkdtempSync(join(tmpdir(), "eve-esi-test-"));

test("character store: first login becomes active, names resolve loosely, ambiguity is explained", () => {
  const home = tempHome();
  const store = new CharacterStore(home);
  assert.throws(() => store.resolve(), /character_login/);
  store.upsert(character(1, "Kara Thrace"));
  store.upsert(character(2, "Kara Agathon"));
  store.upsert(character(3, "Lee Adama"));
  assert.equal(store.resolve().name, "Kara Thrace");
  assert.equal(store.resolve("lee").name, "Lee Adama");
  assert.equal(store.resolve(2).name, "Kara Agathon");
  assert.equal(store.resolve("KARA THRACE").name, "Kara Thrace");
  assert.throws(() => store.resolve("kara"), /\(ambiguous\)/);
  // Another process (CLI login) sees the same file.
  assert.equal(new CharacterStore(home).list().length, 3);
  store.remove(1);
  assert.equal(store.resolve().name, "Kara Agathon", "active moves to the next character");
});

test("character store: a transferred character drops the old grant", () => {
  const store = new CharacterStore(tempHome());
  store.upsert({ ...character(1, "Pilot"), last_refresh_error: "invalid_grant" });
  store.upsert({ ...character(1, "Pilot"), owner_hash: "new-owner", scopes: ["a"] });
  assert.equal(store.get(1)!.last_refresh_error, undefined);
  store.upsert({ ...character(1, "Pilot"), owner_hash: "new-owner", scopes: ["b"] });
  assert.deepEqual(store.get(1)!.scopes, ["b"]);
  assert.match(readFileSync(join((store as any).path), "utf8"), /"new-owner"/);
});

test("reply drops empty fields and adds copyable text blocks; raw keeps everything", () => {
  const r = reply({ a: 1, b: null, c: [] }, { texts: ["[Rifter, x]"] });
  assert.deepEqual(r.content, [{ type: "text", text: JSON.stringify({ a: 1 }, null, 1) }, { type: "text", text: "[Rifter, x]" }]);
  assert.match((reply({ b: null }, { raw: true }).content[0] as any).text, /"b": null/);
});

test("handler turns thrown errors into readable tool errors", async () => {
  const user = await handler(async () => { throw new UserError("Call character_login first."); })({});
  assert.deepEqual(user, { content: [{ type: "text", text: "Call character_login first." }], isError: true });
  assert.match((errorReply(esiError(404, "nope", "/x")).content[0] as any).text, /^ESI 404 on \/x: nope$/);
  const bug = errorReply(new TypeError("x is undefined"));
  assert.match((bug.content[0] as any).text, /^Unexpected error: x is undefined/);
});

test("section records a failing part instead of failing the whole call", async () => {
  const errors: Record<string, string> = {};
  const [ok, bad] = await Promise.all([
    section(errors, "wallet", async () => 5),
    section(errors, "loyalty", async () => { throw new UserError("missing scope"); }),
  ]);
  assert.equal(ok, 5);
  assert.equal(bad, undefined);
  assert.deepEqual(errors, { loyalty: "missing scope" });
});

test("mapLimit keeps order and bounds concurrency", async () => {
  let running = 0, peak = 0;
  const out = await mapLimit([5, 1, 3, 2, 4], 2, async (n) => {
    peak = Math.max(peak, ++running);
    await new Promise((r) => setTimeout(r, n));
    running--;
    return n * 10;
  });
  assert.deepEqual(out, [50, 10, 30, 20, 40]);
  assert.equal(peak, 2);
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
});

test("util formatting edge cases", () => {
  assert.equal(isk(-2_500_000), "-2.50m ISK");
  assert.equal(isk(999), "999.00 ISK");
  assert.equal(isk(null), null);
  assert.equal(isk(NaN), null);
  assert.equal(duration(0), "0s");
  assert.equal(duration(45_000), "45s");
  assert.equal(duration((2 * 86400 + 3 * 3600 + 5 * 60) * 1000), "2d 3h", "minutes are dropped once days show");
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.equal(
    stripHtml('<font size="12">Hi<br>see <a href="showinfo:1377//90000001">Bob</a> &amp; co</p>x</font>'),
    "Hi\nsee Bob & co\nx",
  );
});

test("scope presets: readonly has no writes, full contains standard, no duplicates", () => {
  assert.ok(READONLY_SCOPES.every((s) => !/write|send_mail|open_window/.test(s)));
  assert.ok(READONLY_SCOPES.includes("esi-wallet.read_character_wallet.v1"));
  assert.ok(STANDARD_SCOPES.every((s) => FULL_SCOPES.includes(s)));
  for (const list of [STANDARD_SCOPES, FULL_SCOPES]) assert.equal(new Set(list).size, list.length);
  assert.ok([...STANDARD_SCOPES, ...FULL_SCOPES].every((s) => /^esi-[a-z]+\.[a-z_]+\.v\d$/.test(s)));
});
