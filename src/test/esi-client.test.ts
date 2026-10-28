// The real Esi client against a stubbed fetch: caching, paging, write invalidation and error messages.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { COMPATIBILITY_DATE, type Config } from "../config.js";
import { Esi, EsiError } from "../esi/client.js";
import type { Sso } from "../auth/sso.js";
import { character } from "./harness.js";

interface Seen {
  method: string;
  url: URL;
  headers: Record<string, string>;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replaces fetch with `answer`, recording each request. */
function stubFetch(answer: (req: Seen, n: number) => Response): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: URL, init: RequestInit) => {
    const req = { method: init.method ?? "GET", url: new URL(input), headers: init.headers as Record<string, string> };
    seen.push(req);
    return answer(req, seen.length);
  }) as typeof fetch;
  return seen;
}

const json = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const inAMinute = () => new Date(Date.now() + 60_000).toUTCString();
const expired = () => new Date(Date.now() - 1000).toUTCString();

function client() {
  const cfg = { userAgent: "eve-esi-mcp tests" } as Config;
  const sso = { accessToken: async () => "token-123" } as unknown as Sso;
  return new Esi(cfg, sso);
}

test("sends the compatibility date, user agent and the character's token", async () => {
  const seen = stubFetch(() => json({ ok: true }));
  const pilot = character(1, "Pilot");
  await client().get("/characters/1/wallet", { character: pilot, scope: "esi-wallet.read_character_wallet.v1", query: { ids: [1, 2] } });
  assert.equal(seen[0].headers["X-Compatibility-Date"], COMPATIBILITY_DATE);
  assert.equal(seen[0].headers["User-Agent"], "eve-esi-mcp tests");
  assert.equal(seen[0].headers.Authorization, "Bearer token-123");
  assert.equal(seen[0].url.searchParams.get("ids"), "1,2");
});

test("GETs are served from cache until Expires, then revalidated with the ETag", async () => {
  const seen = stubFetch((_, n) =>
    n === 1 ? json({ v: 1 }, { expires: inAMinute(), etag: '"a"' })
    : n === 2 ? new Response(null, { status: 304, headers: { expires: expired() } })
    : json({ v: 2 }, { expires: inAMinute() }),
  );
  const esi = client();
  assert.deepEqual(await esi.get("/status"), { v: 1 });
  assert.deepEqual(await esi.get("/status"), { v: 1 });
  assert.equal(seen.length, 1, "second call hit the cache");
  assert.deepEqual(await esi.get("/status", { fresh: true }), { v: 1 }, "304 keeps the cached body");
  assert.equal(seen[1].headers["If-None-Match"], '"a"');
});

test("getAllPages fetches every X-Pages page and concatenates them", async () => {
  const seen = stubFetch((req) => json([`p${req.url.searchParams.get("page")}`], { "x-pages": "3", expires: inAMinute() }));
  const r = await client().getAllPages<string>("/markets/10000002/orders");
  assert.deepEqual(r, { items: ["p1", "p2", "p3"], pages: 3, truncated: false });
  assert.equal(seen.length, 3);
  const capped = await client().getAllPages<string>("/markets/10000002/orders", {}, 2);
  assert.equal(capped.truncated, true);
});

test("a write clears cached GETs of the written route's collection", async () => {
  const seen = stubFetch((req) => (req.method === "GET" ? json([seen.length], { expires: inAMinute() }) : json({ fitting_id: 9 }, {}, 201)));
  const esi = client();
  const pilot = character(1, "Pilot");
  await esi.get("/characters/1/fittings", { character: pilot });
  await esi.request("DELETE", "/characters/1/fittings/5", { character: pilot });
  await esi.get("/characters/1/fittings", { character: pilot });
  assert.deepEqual(seen.map((s) => s.method), ["GET", "DELETE", "GET"]);
});

test("errors carry the status and a next step; tryGet turns 403/404 into null", async () => {
  stubFetch(() => json({ error: "Character not found" }, {}, 404));
  await assert.rejects(client().get("/characters/2"), (e: unknown) => e instanceof EsiError && e.status === 404 && /404 Not Found on \/characters\/2: Character not found/.test(e.message));
  assert.equal(await client().tryGet("/characters/2"), null);
  stubFetch(() => json({ error: "token is expired" }, {}, 401));
  await assert.rejects(client().get("/characters/2/assets"), /log in again \(character_login\)/);
});

test("a missing scope fails before any request and names the right preset", async () => {
  const seen = stubFetch(() => json({}));
  const pilot = character(1, "Pilot", []);
  await assert.rejects(client().get("/x", { character: pilot, scope: "esi-wallet.read_character_wallet.v1" }), /"standard" scope preset/);
  await assert.rejects(client().get("/x", { character: pilot, scope: "esi-corporations.read_structures.v1" }), /"full" scope preset/);
  await assert.rejects(client().get("/x", { character: pilot, scope: "esi-made-up.v1" }), /with scopes including "esi-made-up.v1"/);
  assert.equal(seen.length, 0);
});

test("server errors are retried", async () => {
  const seen = stubFetch((_, n) => (n === 1 ? json({ error: "boom" }, {}, 502) : json({ ok: true })));
  assert.deepEqual(await client().get("/status"), { ok: true });
  assert.equal(seen.length, 2);
});
