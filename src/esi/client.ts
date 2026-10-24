import { COMPATIBILITY_DATE, ESI_BASE, type Config } from "../config.js";
import { SCOPE_PRESETS } from "../auth/scopes.js";
import type { Sso } from "../auth/sso.js";
import type { StoredCharacter } from "../auth/store.js";
import { UserError, log, mapLimit } from "../util.js";

export interface EsiOptions {
  character?: StoredCharacter;
  /** Scope the route needs; checked up-front so the model gets an actionable error. */
  scope?: string;
  query?: Record<string, string | number | boolean | Array<string | number> | undefined>;
  body?: unknown;
  /** Bypass the local response cache. */
  fresh?: boolean;
}

export interface EsiResponse<T> {
  data: T;
  status: number;
  pages: number;
  expires?: string;
  lastModified?: string;
}

interface CacheEntry {
  etag?: string;
  expires: number;
  data: unknown;
  pages: number;
  lastModified?: string;
}

export class EsiError extends Error {
  constructor(public status: number, message: string, public path: string) {
    super(message);
    this.name = "EsiError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_CACHE = 2000;

/** ESI HTTP client: auth, compatibility date, ETag/expires caching, X-Pages fan-out and rate-limit backoff. */
export class Esi {
  private cache = new Map<string, CacheEntry>();
  private errorLimitPauseUntil = 0;

  constructor(private cfg: Config, private sso: Sso) {}

  requireScope(character: StoredCharacter, scope: string) {
    if (!character.scopes.includes(scope)) {
      // Point at the smallest preset that actually contains the scope (corporation scopes are only in "full").
      const preset = ["standard", "full"].find((p) => SCOPE_PRESETS[p].includes(scope));
      throw new UserError(
        `${character.name} has not granted the scope "${scope}". Call character_login ` +
          (preset ? `with the "${preset}" scope preset` : `with scopes including "${scope}"`) +
          " to re-authorize this character.",
      );
    }
  }

  async request<T>(method: string, path: string, opts: EsiOptions = {}): Promise<EsiResponse<T>> {
    if (opts.character && opts.scope) this.requireScope(opts.character, opts.scope);
    const url = new URL(ESI_BASE + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined) continue;
      url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
    }
    const key = `${method} ${url} ${opts.character?.id ?? ""} ${opts.body ? JSON.stringify(opts.body) : ""}`;
    const cached = this.cache.get(key);
    if (method === "GET" && cached && !opts.fresh && cached.expires > Date.now()) {
      return { data: cached.data as T, status: 200, pages: cached.pages, lastModified: cached.lastModified };
    }

    for (let attempt = 0; ; attempt++) {
      const pause = this.errorLimitPauseUntil - Date.now();
      if (pause > 0) await sleep(Math.min(pause, 60_000));

      const headers: Record<string, string> = {
        "User-Agent": this.cfg.userAgent,
        "X-Compatibility-Date": COMPATIBILITY_DATE,
        Accept: "application/json",
        "Accept-Language": "en",
      };
      if (opts.character) headers.Authorization = `Bearer ${await this.sso.accessToken(opts.character.id)}`;
      if (method === "GET" && cached?.etag) headers["If-None-Match"] = cached.etag;
      if (opts.body !== undefined) headers["Content-Type"] = "application/json";

      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        if (attempt < 2) { await sleep(1000 * (attempt + 1)); continue; }
        throw new EsiError(0, `ESI request failed: ${(err as Error).message}`, path);
      }

      const remain = Number(res.headers.get("x-esi-error-limit-remain"));
      const reset = Number(res.headers.get("x-esi-error-limit-reset"));
      if (Number.isFinite(remain) && res.headers.has("x-esi-error-limit-remain") && remain < 10) {
        this.errorLimitPauseUntil = Date.now() + (reset + 1) * 1000;
        log(`ESI error limit low (${remain}); pausing ${reset}s`);
      }

      if (res.status === 304 && cached) {
        cached.expires = parseExpires(res.headers.get("expires"));
        return { data: cached.data as T, status: 200, pages: cached.pages, lastModified: cached.lastModified };
      }

      if (res.status === 429 || res.status === 420) {
        const wait = Number(res.headers.get("retry-after") ?? res.headers.get("x-esi-error-limit-reset") ?? 5);
        if (attempt < 2 && wait <= 30) { await sleep(wait * 1000); continue; }
        throw new EsiError(res.status, `ESI rate limit reached for ${path}; retry in ${wait}s.`, path);
      }
      if (res.status >= 500 && attempt < 2) {
        await sleep(1000 * (attempt + 1));
        continue;
      }

      const text = await res.text();
      let data: any = null;
      if (text) {
        try { data = JSON.parse(text); } catch { data = text; }
      }
      if (!res.ok) {
        const msg = typeof data === "object" && data?.error ? data.error : String(text).slice(0, 300);
        throw new EsiError(res.status, describeError(res.status, msg, path), path);
      }

      const pages = Number(res.headers.get("x-pages") ?? 1) || 1;
      const lastModified = res.headers.get("last-modified") ?? undefined;
      if (method === "GET") {
        if (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, {
          etag: res.headers.get("etag") ?? undefined,
          expires: parseExpires(res.headers.get("expires")),
          data,
          pages,
          lastModified,
        });
      } else {
        this.invalidate(url.pathname);
      }
      return { data: data as T, status: res.status, pages, expires: res.headers.get("expires") ?? undefined, lastModified };
    }
  }

  /**
   * Drops cached GETs a write may have changed: the written route, anything below it, and its parent collection
   * (e.g. DELETE /characters/1/fittings/2 also clears GET /characters/1/fittings).
   */
  private invalidate(pathname: string) {
    const parent = pathname.replace(/\/[^/]+\/?$/, "/");
    const self = pathname.endsWith("/") ? pathname : pathname + "/";
    for (const key of [...this.cache.keys()]) {
      if (!key.startsWith("GET ")) continue;
      const p = new URL(key.split(" ")[1]).pathname;
      const dir = p.endsWith("/") ? p : p + "/";
      if (dir.startsWith(self) || dir === parent) this.cache.delete(key);
    }
  }

  async get<T>(path: string, opts: EsiOptions = {}): Promise<T> {
    return (await this.request<T>("GET", path, opts)).data;
  }

  async post<T>(path: string, body: unknown, opts: EsiOptions = {}): Promise<T> {
    return (await this.request<T>("POST", path, { ...opts, body })).data;
  }

  /** Fetches every page of an X-Pages route (up to maxPages) and concatenates the arrays. */
  async getAllPages<T>(path: string, opts: EsiOptions = {}, maxPages = 100): Promise<{ items: T[]; pages: number; truncated: boolean }> {
    const first = await this.request<T[]>("GET", path, { ...opts, query: { ...opts.query, page: 1 } });
    const total = first.pages;
    const last = Math.min(total, maxPages);
    const rest = await mapLimit(
      Array.from({ length: Math.max(0, last - 1) }, (_, i) => i + 2),
      6,
      (page) => this.get<T[]>(path, { ...opts, query: { ...opts.query, page } }),
    );
    return { items: [first.data, ...rest].flat(), pages: total, truncated: total > maxPages };
  }

  /** Like get(), but returns null instead of throwing on 403/404 (e.g. structures without docking access). */
  async tryGet<T>(path: string, opts: EsiOptions = {}): Promise<T | null> {
    try {
      return await this.get<T>(path, opts);
    } catch (err) {
      if (err instanceof EsiError && (err.status === 403 || err.status === 404 || err.status === 401)) return null;
      throw err;
    }
  }
}

function parseExpires(h: string | null): number {
  const t = h ? Date.parse(h) : NaN;
  return Number.isFinite(t) ? t : Date.now() + 60_000;
}

function describeError(status: number, msg: string, path: string): string {
  switch (status) {
    case 401: return `ESI 401 Unauthorized on ${path}: ${msg}. The character may need to log in again (character_login).`;
    case 403: return `ESI 403 Forbidden on ${path}: ${msg}. The character lacks the scope or in-game access/roles for this data.`;
    case 404: return `ESI 404 Not Found on ${path}: ${msg}`;
    default: return `ESI ${status} on ${path}: ${msg}`;
  }
}
