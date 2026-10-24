import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StoredCharacter } from "../auth/store.js";
import type { Sde } from "../sde/db.js";
import { chunk, unique } from "../util.js";
import type { Esi } from "./client.js";

export type EntityCategory =
  | "character" | "corporation" | "alliance" | "faction" | "station" | "solar_system" | "region"
  | "constellation" | "inventory_type" | "structure" | "agent" | "unknown";

export interface Entity {
  id: number;
  name: string;
  category: EntityCategory;
}

export interface LocationInfo {
  id: number;
  name: string;
  kind: "station" | "structure" | "solar_system" | "item" | "unknown";
  system?: { id: number; name: string; security: number; security_band: string; region: string | null } | null;
}

const NAME_TTL_MS = 7 * 24 * 3600 * 1000;
const STRUCTURE_TTL_MS = 24 * 3600 * 1000;

/** Fields whose ids resolve to types via the SDE. */
const TYPE_KEYS = new Set([
  "type_id", "ship_type_id", "item_type_id", "weapon_type_id", "skill_id", "blueprint_type_id", "product_type_id",
  "ship_type", "implant_id", "type",
]);
/** Fields whose ids resolve via /universe/names (characters, corporations, alliances, ...). */
const ENTITY_KEYS = new Set([
  "character_id", "corporation_id", "alliance_id", "faction_id", "issuer_id", "issuer_corporation_id", "acceptor_id",
  "assignee_id", "sender_id", "from_id", "first_party_id", "second_party_id", "client_id", "installer_id", "owner_id",
  "creator_id", "ceo_id", "executor_corporation_id", "recipient_id", "from", "completed_character_id", "bidder_id",
  "creator_corporation_id", "tax_receiver_id", "declared_by_id", "aggressor_id", "defender_id",
]);
const LOCATION_KEYS = new Set([
  "location_id", "station_id", "structure_id", "start_location_id", "end_location_id", "facility_id",
  "blueprint_location_id", "output_location_id",
]);
const SYSTEM_KEYS = new Set(["solar_system_id", "system_id", "origin_system_id", "destination_system_id"]);

/**
 * Resolves ids to names using, in order: the SDE (types, systems, NPC stations/corps), a persistent
 * local cache, and ESI (/universe/names, /universe/structures/{id}).
 */
export class Resolver {
  private db: DatabaseSync;

  constructor(home: string, private esi: Esi, private sdeGet: () => Promise<Sde>) {
    this.db = new DatabaseSync(join(home, "cache.sqlite"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS names (id INTEGER PRIMARY KEY, name TEXT, category TEXT, updated_at INTEGER);
      CREATE TABLE IF NOT EXISTS structures (id INTEGER PRIMARY KEY, name TEXT, system_id INTEGER, type_id INTEGER,
        owner_id INTEGER, accessible INTEGER, updated_at INTEGER);
    `);
  }

  /** Resolves character/corporation/alliance/faction/station/system ids (not types) to names. */
  async entities(ids: Iterable<number>): Promise<Map<number, Entity>> {
    const sde = await this.sdeGet();
    const out = new Map<number, Entity>();
    const missing: number[] = [];
    const get = this.db.prepare("SELECT name, category, updated_at FROM names WHERE id = ?");
    for (const id of unique([...ids].filter((x) => Number.isInteger(x) && x > 0))) {
      const local = localEntity(sde, id);
      if (local) { out.set(id, local); continue; }
      const row = get.get(id) as any;
      if (row && Date.now() - row.updated_at < NAME_TTL_MS) out.set(id, { id, name: row.name, category: row.category });
      else if (id < 1e12) missing.push(id);
    }
    if (missing.length) {
      const put = this.db.prepare("INSERT OR REPLACE INTO names VALUES (?,?,?,?)");
      for (const part of chunk(missing, 1000)) {
        let res: Array<{ id: number; name: string; category: EntityCategory }> = [];
        try {
          res = await this.esi.post("/universe/names", part);
        } catch {
          // One bad id fails the whole batch; fall back to resolving individually.
          for (const id of part) {
            try { res.push(...(await this.esi.post<any[]>("/universe/names", [id]))); } catch { /* unresolvable */ }
          }
        }
        for (const e of res) {
          out.set(e.id, e);
          put.run(e.id, e.name, e.category, Date.now());
        }
      }
    }
    return out;
  }

  async entityName(id: number | null | undefined): Promise<string | null> {
    if (!id) return null;
    return (await this.entities([id])).get(id)?.name ?? null;
  }

  /** Resolves a player structure (requires esi-universe.read_structures.v1 and docking access). */
  async structure(id: number, character?: StoredCharacter): Promise<{ name: string; system_id: number | null; type_id: number | null; accessible: boolean }> {
    const row = this.db.prepare("SELECT * FROM structures WHERE id = ?").get(id) as any;
    if (row && Date.now() - row.updated_at < STRUCTURE_TTL_MS) {
      return { name: row.name, system_id: row.system_id, type_id: row.type_id, accessible: !!row.accessible };
    }
    let info: any = null;
    if (character?.scopes.includes("esi-universe.read_structures.v1")) {
      info = await this.esi.tryGet(`/universe/structures/${id}`, { character });
    }
    const result = info
      ? { name: info.name, system_id: info.solar_system_id, type_id: info.type_id ?? null, accessible: true }
      : { name: row?.name ?? `Structure ${id} (no docking access)`, system_id: row?.system_id ?? null, type_id: row?.type_id ?? null, accessible: false };
    this.db.prepare("INSERT OR REPLACE INTO structures VALUES (?,?,?,?,?,?,?)").run(
      id, result.name, result.system_id, result.type_id, info?.owner_id ?? null, result.accessible ? 1 : 0, Date.now(),
    );
    return result;
  }

  /** Resolves a location id (station, structure or solar system) with its system summary. */
  async location(id: number, character?: StoredCharacter): Promise<LocationInfo> {
    const sde = await this.sdeGet();
    const sys = (sid: number | null | undefined) => {
      const s = sid ? sde.systemSummary(sid) : null;
      return s ? { id: s.id, name: s.name, security: s.security, security_band: s.security_band, region: s.region } : null;
    };
    if (id >= 30000000 && id < 33000000) {
      const s = sys(id);
      return { id, name: s?.name ?? `System ${id}`, kind: "solar_system", system: s };
    }
    if (id >= 60000000 && id < 64000000) {
      const st = sde.station(id);
      if (st) return { id, name: st.name, kind: "station", system: sys(st.system_id) };
      const info = await this.esi.tryGet<any>(`/universe/stations/${id}`);
      return { id, name: info?.name ?? `Station ${id}`, kind: "station", system: sys(info?.system_id) };
    }
    if (id >= 1e12) {
      const s = await this.structure(id, character);
      return { id, name: s.name, kind: "structure", system: sys(s.system_id) };
    }
    return { id, name: `Location ${id}`, kind: "unknown", system: null };
  }

  async locations(ids: Iterable<number>, character?: StoredCharacter): Promise<Map<number, LocationInfo>> {
    const out = new Map<number, LocationInfo>();
    for (const id of unique(ids)) out.set(id, await this.location(id, character));
    return out;
  }

  /**
   * Walks an arbitrary ESI payload and adds `<field>_name` next to recognised id fields.
   * Used by the generic esi_request tool so even raw calls come back readable.
   */
  async enrich(value: unknown, character?: StoredCharacter): Promise<unknown> {
    const sde = await this.sdeGet();
    const entityIds = new Set<number>();
    const locationIds = new Set<number>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          if (typeof x === "number") {
            if (ENTITY_KEYS.has(k)) entityIds.add(x);
            else if (LOCATION_KEYS.has(k) && x < 1e12) locationIds.add(x);
            else if (LOCATION_KEYS.has(k) && x >= 1e12 && character) locationIds.add(x);
          } else walk(x);
        }
      }
    };
    walk(value);
    const entities = await this.entities(entityIds);
    const locations = await this.locations([...locationIds].filter((x) => x >= 30000000), character);
    const nameKey = (k: string) => (k.endsWith("_id") ? k.slice(0, -3) : k) + "_name";
    const transform = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(transform);
      if (v && typeof v === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v)) {
          out[k] = transform(x);
          if (typeof x !== "number") continue;
          let name: string | null | undefined;
          if (TYPE_KEYS.has(k)) name = sde.type(x)?.name;
          else if (SYSTEM_KEYS.has(k)) name = sde.system(x)?.name;
          else if (k === "region_id") name = sde.regionName(x);
          else if (k === "constellation_id") name = sde.constellationName(x);
          else if (ENTITY_KEYS.has(k)) name = entities.get(x)?.name;
          else if (LOCATION_KEYS.has(k)) name = locations.get(x)?.name;
          if (name) out[nameKey(k)] = name;
        }
        return out;
      }
      return v;
    };
    return transform(value);
  }
}

function localEntity(sde: Sde, id: number): Entity | null {
  if (id >= 500000 && id < 1000000) {
    const n = sde.factionName(id);
    return n ? { id, name: n, category: "faction" } : null;
  }
  if (id >= 1000000 && id < 2000000) {
    const n = sde.npcCorporationName(id);
    return n ? { id, name: n, category: "corporation" } : null;
  }
  if (id >= 10000000 && id < 13000000) {
    const n = sde.regionName(id);
    return n ? { id, name: n, category: "region" } : null;
  }
  if (id >= 20000000 && id < 23000000) {
    const n = sde.constellationName(id);
    return n ? { id, name: n, category: "constellation" } : null;
  }
  if (id >= 30000000 && id < 33000000) {
    const s = sde.system(id);
    return s ? { id, name: s.name, category: "solar_system" } : null;
  }
  if (id >= 60000000 && id < 64000000) {
    const s = sde.station(id);
    return s ? { id, name: s.name, category: "station" } : null;
  }
  return null;
}
