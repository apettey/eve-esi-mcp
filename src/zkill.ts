import { UserError, log, mapLimit } from "./util.js";

export const ZKILL_BASE = "https://zkillboard.com";

/** zKillboard web path segment -> API filter name. */
const ZKILL_FILTERS: Record<string, string> = {
  alliance: "allianceID",
  corporation: "corporationID",
  character: "characterID",
  ship: "shipTypeID",
  group: "groupID",
  system: "solarSystemID",
  constellation: "constellationID",
  region: "regionID",
  location: "locationID",
  faction: "factionID",
};
const API_FILTERS = new Set(Object.values(ZKILL_FILTERS).concat(["killID", "pastSeconds", "page", "year", "month", "week"]));
const API_FLAGS = new Set(["kills", "losses", "solo", "w-space", "highsec", "lowsec", "nullsec"]);

export interface ZkillRef {
  kind: "zkill";
  id: number;
  hash: string;
}

export type ZkillTarget =
  | { kind: "list"; apiPath: string; members?: { field: "alliance_id" | "corporation_id" | "character_id"; id: number } }
  | { kind: "kill"; id: number }
  | { kind: "related"; systemId: number; time: string };

/**
 * Turns a zKillboard (or br.evetools related) URL into an API request. List pages keep their filters
 * (`/alliance/1/losses/` -> `allianceID/1/losses/`); the entity in the URL decides whose pilots are counted.
 */
export function parseZkillUrl(raw: string): ZkillTarget {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    throw new UserError(`Not a URL: "${raw}".`);
  }
  const host = url.hostname.replace(/^www\./, "");
  const seg = url.pathname.split("/").filter(Boolean);
  if (host === "br.evetools.org") {
    if (seg[0] === "related" && seg[1] && seg[2]) return { kind: "related", systemId: Number(seg[1]), time: relatedTime(seg[2]) };
    throw new UserError(
      "Only br.evetools.org related links (br.evetools.org/related/<system>/<time>) can be read. For a saved report " +
        "(/br/... or /battle/...), pass its system and start time instead, or the zKillboard related link.",
    );
  }
  if (host !== "zkillboard.com") throw new UserError(`Unsupported site "${host}": use a zkillboard.com or br.evetools.org/related URL.`);
  if (seg[0] === "api") seg.shift();
  if (seg[0] === "kill" && seg[1]) return { kind: "kill", id: Number(seg[1]) };
  if (seg[0] === "killID" && seg[1]) return { kind: "kill", id: Number(seg[1]) };
  if (seg[0] === "related" && seg[1] && seg[2]) return { kind: "related", systemId: Number(seg[1]), time: relatedTime(seg[2]) };
  if (seg[0] === "br") throw new UserError("Saved zKillboard battle reports can't be read; use the report's related link (zkillboard.com/related/<system>/<time>/).");

  const parts: string[] = [];
  let members: Extract<ZkillTarget, { kind: "list" }>["members"];
  for (let i = 0; i < seg.length; i++) {
    const s = seg[i];
    const filter = ZKILL_FILTERS[s] ?? (API_FILTERS.has(s) ? s : null);
    if (filter && /^\d+$/.test(seg[i + 1] ?? "")) {
      const id = Number(seg[++i]);
      parts.push(filter, String(id));
      if (!members && (filter === "allianceID" || filter === "corporationID" || filter === "characterID")) {
        members = { field: filter === "allianceID" ? "alliance_id" : filter === "corporationID" ? "corporation_id" : "character_id", id };
      }
    } else if (API_FLAGS.has(s)) parts.push(s);
  }
  if (!parts.some((p) => API_FILTERS.has(p))) throw new UserError(`No zKillboard filter found in "${raw}" (expected e.g. /alliance/<id>/ or /ship/<id>/).`);
  return { kind: "list", apiPath: parts.join("/") + "/", members };
}

/** Related times are YYYYMMDDHH00. Accepts that or any date string, floored to the hour (UTC). */
export function relatedTime(t: string): string {
  if (/^\d{12}$/.test(t)) return t.slice(0, 10) + "00";
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : t.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) throw new UserError(`Unreadable battle time "${t}"; use e.g. "2026-10-27 00:00" (UTC) or 202610270000.`);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}00`;
}

export interface RelatedPilot {
  characterID?: number;
  corporationID?: number;
  allianceID?: number;
  shipTypeID: number;
  isVictim?: boolean;
  killID?: number;
  characterName?: string;
  corporationName?: string;
  allianceName?: string;
}

export interface RelatedReport {
  systemID: number;
  systemName?: string;
  regionName?: string;
  startTime?: string;
  endTime?: string;
  summary: { teamA: { list: RelatedPilot[] }; teamB: { list: RelatedPilot[] } };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal zKillboard API client: User-Agent, small in-memory cache, gentle concurrency and 429 backoff. */
export class Zkill {
  private cache = new Map<string, { at: number; data: unknown }>();
  private hashes = new Map<number, string>();

  constructor(private userAgent: string) {}

  async get<T>(apiPath: string, ttlMs = 5 * 60_000): Promise<T> {
    const url = `${ZKILL_BASE}/api/${apiPath.replace(/^\/+/, "")}`;
    const hit = this.cache.get(url);
    if (hit && Date.now() - hit.at < ttlMs) return hit.data as T;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, { headers: { "User-Agent": this.userAgent, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
      } catch (err) {
        if (attempt < 2) { await sleep(1000 * (attempt + 1)); continue; }
        throw new UserError(`zKillboard request failed: ${(err as Error).message}`);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        const wait = Number(res.headers.get("retry-after")) || 2 * (attempt + 1);
        log(`zKillboard ${res.status}; retrying in ${wait}s`);
        await sleep(Math.min(wait, 20) * 1000);
        continue;
      }
      const text = await res.text();
      let data: any;
      try { data = JSON.parse(text); } catch { data = null; }
      if (!res.ok || data == null) throw new UserError(`zKillboard ${res.status} for ${url}: ${text.slice(0, 200)}`);
      if (data && !Array.isArray(data) && typeof data.error === "string") throw new UserError(`zKillboard: ${data.error}`);
      if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(url, { at: Date.now(), data });
      return data as T;
    }
  }

  /** Killmail id+hash pairs for a list query, newest first (zKill pages hold up to 200). */
  async list(apiPath: string, max: number): Promise<ZkillRef[]> {
    const out: ZkillRef[] = [];
    for (let page = 1; out.length < max && page <= 5; page++) {
      const rows = await this.get<Array<{ killmail_id: number; zkb?: { hash?: string } }>>(`${apiPath}${page > 1 ? `page/${page}/` : ""}`);
      for (const r of rows) {
        if (r.zkb?.hash) { this.hashes.set(r.killmail_id, r.zkb.hash); out.push({ kind: "zkill", id: r.killmail_id, hash: r.zkb.hash }); }
      }
      if (rows.length < 100) break;
    }
    return out.slice(0, max);
  }

  /** Hashes for single kills (zKill has no batch lookup, so this is one request per unknown kill). */
  async hashesFor(ids: number[]): Promise<ZkillRef[]> {
    const got = await mapLimit(ids, 3, async (id) => {
      if (!this.hashes.has(id)) {
        try {
          const rows = await this.get<Array<{ killmail_id: number; zkb?: { hash?: string } }>>(`killID/${id}/`, 24 * 3600_000);
          if (rows[0]?.zkb?.hash) this.hashes.set(id, rows[0].zkb.hash);
        } catch (err) {
          log(`zKillboard hash lookup for ${id} failed: ${(err as Error).message}`);
        }
      }
      const hash = this.hashes.get(id);
      return hash ? ({ kind: "zkill", id, hash } as ZkillRef) : null;
    });
    return got.filter((r): r is ZkillRef => r !== null);
  }

  related(systemId: number, time: string): Promise<RelatedReport> {
    return this.get<RelatedReport>(`related/${systemId}/${time}/`);
  }
}
