// Shared test helpers: the local SDE, a fake ESI, a fake Ctx and an in-process MCP client.
// Tool tests go through the real MCP path (input schema validation, handler(), reply()), so they catch what the
// model would see. See the testing-eve-esi skill for recipes.
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, type Config } from "../config.js";
import { Ctx } from "../context.js";
import { CharacterStore, type StoredCharacter } from "../auth/store.js";
import { STANDARD_SCOPES } from "../auth/scopes.js";
import { Esi, EsiError, type EsiOptions } from "../esi/client.js";
import { Resolver } from "../esi/resolver.js";
import { Sde } from "../sde/db.js";
import { buildServer } from "../server.js";

// ---------------------------------------------------------------------------------------------------------------
// Static data

/** The user's local SDE index, or null (tests that need it skip; run the server or `sde-update` once). */
export function openSde(): Sde | null {
  try {
    const pointer = join(loadConfig().home, "sde-current.json");
    if (!existsSync(pointer)) return null;
    const p = JSON.parse(readFileSync(pointer, "utf8"));
    return existsSync(p.path) ? new Sde(p.path) : null;
  } catch {
    return null;
  }
}

export const sde = openSde();
/** `test`, or `test.skip` when no SDE index exists (e.g. in CI). */
export const withSde = sde ? test : test.skip;

// ---------------------------------------------------------------------------------------------------------------
// Fake ESI

export interface EsiCall {
  method: string;
  path: string;
  opts: EsiOptions;
}

/** A route answer: a value, or a function of the request (throw `esiError(...)` to simulate a failure). */
export type Route = unknown | ((opts: EsiOptions & { method: string; path: string }) => unknown);

/** An ESI error as the real client throws it (status + the message the model would see). */
export function esiError(status: number, message = "error", path = "/"): EsiError {
  return new EsiError(status, `ESI ${status} on ${path}: ${message}`, path);
}

/**
 * Stands in for `Esi`. Routes are keyed by "METHOD /path" or just "/path" (any method); arrays are served as single
 * pages to getAllPages. The scope check is the real one, so missing-scope messages match production. Unknown routes
 * throw, naming the route, so a test never silently talks to nothing.
 */
export class FakeEsi {
  calls: EsiCall[] = [];

  constructor(public routes: Record<string, Route> = {}) {}

  requireScope(character: StoredCharacter, scope: string) {
    Esi.prototype.requireScope.call(this, character, scope);
  }

  async request<T>(method: string, path: string, opts: EsiOptions = {}) {
    if (opts.character && opts.scope) this.requireScope(opts.character, opts.scope);
    this.calls.push({ method, path, opts });
    const key = `${method} ${path}`;
    const route = key in this.routes ? this.routes[key] : this.routes[path];
    if (route === undefined) throw new Error(`FakeEsi: no route for ${key}. Add it to the routes in this test.`);
    const data = typeof route === "function" ? await (route as Function)({ ...opts, method, path }) : structuredClone(route);
    return { data: data as T, status: 200, pages: 1 };
  }

  async get<T>(path: string, opts: EsiOptions = {}): Promise<T> {
    return (await this.request<T>("GET", path, opts)).data;
  }

  async post<T>(path: string, body: unknown, opts: EsiOptions = {}): Promise<T> {
    return (await this.request<T>("POST", path, { ...opts, body })).data;
  }

  async getAllPages<T>(path: string, opts: EsiOptions = {}) {
    const items = await this.get<T[]>(path, opts);
    return { items, pages: 1, truncated: false };
  }

  async tryGet<T>(path: string, opts: EsiOptions = {}): Promise<T | null> {
    try {
      return await this.get<T>(path, opts);
    } catch (err) {
      if (err instanceof EsiError && [401, 403, 404].includes(err.status)) return null;
      throw err;
    }
  }

  /** Calls made to a path (any method), for asserting what a tool asked ESI for. */
  callsTo(path: string): EsiCall[] {
    return this.calls.filter((c) => c.path === path);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Fake context

export function character(id: number, name: string, scopes: string[] = STANDARD_SCOPES): StoredCharacter {
  return { id, name, owner_hash: `hash-${id}`, scopes, refresh_token: "test", added_at: "2026-01-01T00:00:00Z" };
}

export interface TestCtxOptions {
  /** ESI routes for a FakeEsi, or your own fake. */
  esi?: Record<string, Route> | FakeEsi;
  /** Logged-in characters; the first is active. */
  characters?: StoredCharacter[];
  /** Static data; defaults to the local index (tests using it should be `withSde`). */
  sde?: Sde | null;
  /** Any other Ctx members to replace (zkill, sso, sdeManager, ...). */
  overrides?: Record<string, unknown>;
}

export interface TestCtx extends Ctx {
  esi: FakeEsi & Ctx["esi"];
}

/**
 * A real Ctx (store, resolver, character resolution) over a temp data directory, with ESI faked. Entity names go
 * through the real Resolver, so answer "POST /universe/names" in `esi` when the tool resolves characters/corps.
 */
export function testCtx(opts: TestCtxOptions = {}): TestCtx {
  const home = mkdtempSync(join(tmpdir(), "eve-esi-test-"));
  const cfg: Config = { home, callbackUrl: "http://localhost:8642/callback", userAgent: "eve-esi-mcp tests", openBrowser: false };
  const esi = opts.esi instanceof FakeEsi ? opts.esi : new FakeEsi(opts.esi);
  const store = new CharacterStore(home);
  for (const c of opts.characters ?? []) store.upsert(c);
  const staticData = opts.sde === undefined ? sde : opts.sde;
  const sdeGet = async () => {
    if (!staticData) throw new Error("This test needs the SDE index; guard it with withSde.");
    return staticData;
  };
  const ctx = Object.create(Ctx.prototype) as TestCtx;
  Object.assign(ctx, {
    cfg,
    store,
    esi,
    sso: { configured: true, accessToken: async () => "test-token" },
    resolver: new Resolver(home, esi as unknown as Esi, sdeGet),
    sde: sdeGet,
    sdeManager: { status: () => ({ status: "test" }) },
    zkill: {},
    ...opts.overrides,
  });
  return ctx;
}

// ---------------------------------------------------------------------------------------------------------------
// Calling tools

export interface ToolResult {
  isError: boolean;
  /** The first text block: JSON for normal replies, the message for errors. */
  text: string;
  /** Every text block after the first (copyable EFT, mail bodies, ...). */
  texts: string[];
  /** The first block parsed as JSON (throws for error replies or plain text). */
  json: any;
}

/** Connects an MCP client to `server` (default: every tool, via buildServer) in-process. */
export async function connect(ctx: Ctx, server: McpServer = buildServer(ctx)) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "eve-esi-tests", version: "0" });
  await client.connect(clientSide);
  return {
    client,
    async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
      const r = await client.callTool({ name, arguments: args });
      const blocks = (r.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? `[${c.type}]`);
      const text = blocks[0] ?? "";
      return {
        isError: !!r.isError,
        text,
        texts: blocks.slice(1),
        get json() {
          return JSON.parse(text);
        },
      };
    },
    close: () => client.close(),
  };
}

/** One-shot: call a tool against a ctx and close the connection. */
export async function callTool(ctx: Ctx, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const conn = await connect(ctx);
  try {
    return await conn.call(name, args);
  } finally {
    await conn.close();
  }
}
