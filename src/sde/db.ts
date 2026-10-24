import { DatabaseSync, type StatementSync } from "node:sqlite";
import { norm, round } from "../util.js";

export const CATEGORY = {
  ship: 6,
  module: 7,
  charge: 8,
  blueprint: 9,
  skill: 16,
  drone: 18,
  implant: 20,
  subsystem: 32,
  structure: 65,
  structureModule: 66,
  fighter: 87,
} as const;

/** requiredSkillN -> requiredSkillNLevel attribute pairs. */
export const REQUIRED_SKILL_ATTRS: Array<[number, number]> = [
  [182, 277], [183, 278], [184, 279], [1285, 1286], [1289, 1287], [1290, 1288],
];

export const ATTR = {
  hp: 9, powerOutput: 11, lowSlots: 12, medSlots: 13, hiSlots: 14, cpuOutput: 48, cpu: 50, power: 30,
  maxVelocity: 37, maxTargetRange: 76, launcherHardpoints: 101, turretHardpoints: 102, shieldCapacity: 263,
  armorHP: 265, droneCapacity: 283, capacitorCapacity: 482, rechargeRate: 55, shieldRechargeRate: 479,
  signatureRadius: 552, scanResolution: 564, maxLockedTargets: 192, calibration: 1132, upgradeCost: 1153,
  rigSlots: 1137, upgradeSlotsLeft: 1154, droneBandwidth: 1271, droneBandwidthUsed: 1272, warpSpeed: 1281,
  agility: 70, mass: 4, skillRank: 275, primaryAttribute: 180, secondaryAttribute: 181, rigSize: 1547,
  subsystemSlots: 1367, implantSlot: 331, boosterSlot: 1087, metaLevel: 633, techLevel: 422,
  shieldEm: 271, shieldExplosive: 272, shieldKinetic: 273, shieldThermal: 274,
  armorEm: 267, armorExplosive: 268, armorKinetic: 269, armorThermal: 270,
  hullEm: 974, hullExplosive: 975, hullKinetic: 976, hullThermal: 977,
  charisma: 164, intelligence: 165, memory: 166, perception: 167, willpower: 168,
} as const;

export interface TypeRow {
  id: number;
  name: string;
  group_id: number;
  group: string | null;
  category_id: number | null;
  category: string | null;
  published: number;
  market_group_id: number | null;
  meta_group_id: number | null;
  meta_group: string | null;
  meta_level: number | null;
  tech_level: number | null;
  volume: number | null;
  packaged_volume: number | null;
  capacity: number | null;
  mass: number | null;
  base_price: number | null;
  portion_size: number;
  variation_parent_id: number | null;
  description: string | null;
  slot: string | null;
  hardpoint: string | null;
}

export interface AttributeDef {
  id: number;
  name: string;
  display_name: string | null;
  category_id: number | null;
  unit_id: number | null;
  published: number;
  high_is_good: number;
  default_value: number;
}

interface SearchEntry {
  id: number;
  name: string;
  lc: string;
  categoryId: number;
  groupId: number;
  metaGroupId: number | null;
  marketGroupId: number | null;
}

/** Blueprints, SKINs, Personalization (emblems). */
const NOISE_CATEGORIES = new Set<number>([CATEGORY.blueprint, 91, 2118]);

/** Common player shorthand, expanded before searching. */
const ALIASES: Record<string, string> = {
  mwd: "microwarpdrive",
  ab: "afterburner",
  dc: "damage control",
  dcu: "damage control",
  lse: "large shield extender",
  mse: "medium shield extender",
  eanm: "energized adaptive nano membrane",
  dda: "drone damage amplifier",
  bcs: "ballistic control system",
  te: "tracking enhancer",
  tc: "tracking computer",
  scram: "warp scrambler",
  disruptor: "warp disruptor",
  point: "warp disruptor",
  web: "stasis webifier",
  neut: "energy neutralizer",
  nos: "energy nosferatu",
  "cap booster": "capacitor booster",
  asb: "ancillary shield booster",
  aar: "ancillary armor repairer",
  plex: "pilot's license extension",
  mjd: "micro jump drive",
  ccc: "capacitor control circuit",
  nano: "nanofiber internal structure",
  istab: "inertial stabilizers",
  dscan: "directional scanner",
};

export class Sde {
  readonly db: DatabaseSync;
  readonly build: number;
  private stmts = new Map<string, StatementSync>();
  private searchIndex?: SearchEntry[];
  private exactNames?: Map<string, number>;
  private attrDefs?: Map<number, AttributeDef>;
  private units?: Map<number, string | null>;
  private attrCategories?: Map<number, string>;
  private typeCache = new Map<number, TypeRow | null>();

  constructor(path: string) {
    this.db = new DatabaseSync(path, { readOnly: true });
    this.build = Number(this.q("SELECT value FROM meta WHERE key='build'").get()?.value ?? 0);
  }

  close() {
    this.db.close();
  }

  private q(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  // ---------- types ----------

  type(id: number): TypeRow | null {
    if (this.typeCache.has(id)) return this.typeCache.get(id)!;
    const row = (this.q(`
      SELECT t.*, g.name AS "group", g.category_id, c.name AS category, mg.name AS meta_group
      FROM types t LEFT JOIN groups g ON g.id = t.group_id LEFT JOIN categories c ON c.id = g.category_id
      LEFT JOIN meta_groups mg ON mg.id = t.meta_group_id WHERE t.id = ?`).get(id) as unknown as TypeRow) ?? null;
    this.typeCache.set(id, row);
    return row;
  }

  typeName(id: number): string {
    return this.type(id)?.name ?? `Unknown type ${id}`;
  }

  /** Exact (case-insensitive) name lookup, preferring published types. */
  typeIdByName(name: string): number | null {
    if (!this.exactNames) {
      this.exactNames = new Map();
      const rows = this.q("SELECT id, name, published FROM types ORDER BY published ASC, id DESC").all() as any[];
      for (const r of rows) if (r.name) this.exactNames.set(norm(r.name), r.id);
    }
    return this.exactNames.get(norm(name)) ?? null;
  }

  private loadSearchIndex(): SearchEntry[] {
    if (!this.searchIndex) {
      const rows = this.q(`
        SELECT t.id, t.name, t.group_id, g.category_id, t.meta_group_id, t.market_group_id
        FROM types t JOIN groups g ON g.id = t.group_id WHERE t.published = 1 AND t.name IS NOT NULL`).all() as any[];
      this.searchIndex = rows.map((r) => ({
        id: r.id, name: r.name, lc: norm(r.name), categoryId: r.category_id, groupId: r.group_id,
        metaGroupId: r.meta_group_id, marketGroupId: r.market_group_id,
      }));
    }
    return this.searchIndex;
  }

  searchTypes(
    query: string,
    opts: { categoryIds?: number[]; groupIds?: number[]; metaGroupIds?: number[]; marketOnly?: boolean; limit?: number } = {},
  ): Array<{ id: number; score: number }> {
    let q = norm(query);
    if (ALIASES[q]) q = ALIASES[q];
    else q = q.split(" ").map((w) => ALIASES[w] ?? w).join(" ");
    const tokens = q.split(" ").filter(Boolean);
    const limit = opts.limit ?? 10;
    // Blueprints, SKINs and emblems swamp most searches; only include them when asked for.
    const hideNoise = !opts.categoryIds?.length && !/blueprint|skin|emblem|bpc?/.test(q);
    const filter = (e: SearchEntry) =>
      (!hideNoise || !NOISE_CATEGORIES.has(e.categoryId)) &&
      (!opts.categoryIds?.length || opts.categoryIds.includes(e.categoryId)) &&
      (!opts.groupIds?.length || opts.groupIds.includes(e.groupId)) &&
      (!opts.metaGroupIds?.length || (e.metaGroupId != null && opts.metaGroupIds.includes(e.metaGroupId))) &&
      (!opts.marketOnly || e.marketGroupId != null);
    const hits: Array<{ id: number; score: number }> = [];
    for (const e of this.loadSearchIndex()) {
      if (!filter(e)) continue;
      let score = 0;
      if (e.lc === q) score = 1000;
      else if (e.lc.startsWith(q)) score = 600;
      else if (e.lc.includes(" " + q) || e.lc.includes("-" + q)) score = 400;
      else if (e.lc.includes(q)) score = 300;
      else if (tokens.length > 1 && tokens.every((t) => e.lc.includes(t))) score = 200;
      if (!score) continue;
      // Prefer tighter matches and items with a market presence.
      score -= Math.min(100, e.lc.length - q.length);
      if (e.marketGroupId != null) score += 20;
      hits.push({ id: e.id, score });
    }
    if (!hits.length && q.length >= 4) {
      const qg = trigrams(q);
      for (const e of this.loadSearchIndex()) {
        if (!filter(e)) continue;
        const sim = dice(qg, trigrams(e.lc));
        if (sim >= 0.45) hits.push({ id: e.id, score: Math.round(sim * 100) });
      }
    }
    hits.sort((a, b) => b.score - a.score || this.typeName(a.id).localeCompare(this.typeName(b.id)));
    return hits.slice(0, limit);
  }

  categoryIdsByName(name: string): number[] {
    const n = norm(name).replace(/s$/, "");
    return (this.q("SELECT id, name FROM categories WHERE published = 1").all() as any[])
      .filter((r) => norm(r.name).replace(/s$/, "") === n || norm(r.name).startsWith(n))
      .map((r) => r.id);
  }

  groupIdsByName(name: string): number[] {
    const n = norm(name);
    const rows = this.q("SELECT id, name FROM groups WHERE published = 1").all() as any[];
    const exact = rows.filter((r) => norm(r.name) === n || norm(r.name) === n.replace(/s$/, ""));
    return (exact.length ? exact : rows.filter((r) => norm(r.name).includes(n))).map((r) => r.id);
  }

  metaGroupIdsByName(name: string): number[] {
    const n = norm(name).replace(/^t(\d)$/, "tech $1");
    return (this.q("SELECT id, name FROM meta_groups").all() as any[])
      .filter((r) => norm(r.name) === n || norm(r.name).includes(n))
      .map((r) => r.id);
  }

  marketGroupPath(id: number | null): string | null {
    const parts: string[] = [];
    let cur = id;
    for (let i = 0; cur != null && i < 10; i++) {
      const r = this.q("SELECT parent_id, name FROM market_groups WHERE id = ?").get(cur) as any;
      if (!r) break;
      parts.unshift(r.name);
      cur = r.parent_id;
    }
    return parts.length ? parts.join(" > ") : null;
  }

  variations(typeId: number): number[] {
    const t = this.type(typeId);
    if (!t) return [];
    const parent = t.variation_parent_id ?? typeId;
    return (this.q(`SELECT id FROM types WHERE published = 1 AND (id = ? OR variation_parent_id = ?)
      ORDER BY meta_level, id`).all(parent, parent) as any[]).map((r) => r.id);
  }

  typeBonus(typeId: number): any | null {
    const r = this.q("SELECT data FROM type_bonus WHERE type_id = ?").get(typeId) as any;
    return r ? JSON.parse(r.data) : null;
  }

  // ---------- dogma ----------

  attributeDefs(): Map<number, AttributeDef> {
    if (!this.attrDefs) {
      this.attrDefs = new Map();
      for (const r of this.q("SELECT * FROM attributes").all() as any[]) this.attrDefs.set(r.id, r);
      this.units = new Map((this.q("SELECT id, display_name FROM units").all() as any[]).map((r) => [r.id, r.display_name]));
      this.attrCategories = new Map((this.q("SELECT id, name FROM attribute_categories").all() as any[]).map((r) => [r.id, r.name]));
    }
    return this.attrDefs;
  }

  attributeCategory(id: number | null): string {
    this.attributeDefs();
    return (id != null && this.attrCategories!.get(id)) || "Other";
  }

  typeAttributes(typeId: number): Map<number, number> {
    const rows = this.q("SELECT attribute_id, value FROM type_attributes WHERE type_id = ?").all(typeId) as any[];
    return new Map(rows.map((r) => [r.attribute_id, r.value]));
  }

  attr(typeId: number, attributeId: number): number | null {
    const r = this.q("SELECT value FROM type_attributes WHERE type_id = ? AND attribute_id = ?").get(typeId, attributeId) as any;
    return r ? r.value : null;
  }

  /** Human readable attribute value, applying EVE's unit conventions. */
  formatAttribute(attributeId: number, value: number): string {
    const def = this.attributeDefs().get(attributeId);
    const unitId = def?.unit_id ?? null;
    const unit = unitId != null ? this.units!.get(unitId) ?? "" : "";
    const num = (v: number) => {
      const r = Math.abs(v) >= 100 ? round(v, 1) : round(v, 3);
      return r.toLocaleString("en-US", { maximumFractionDigits: 3 });
    };
    switch (unitId) {
      case 101: return `${num(value / 1000)} s`;
      case 108: return `${num((1 - value) * 100)}%`;
      case 109: return `${value >= 1 ? "+" : ""}${num((value - 1) * 100)}%`;
      case 111: return `${num((1 - value) * 100)}%`;
      case 127: return `${num(value * 100)}%`;
      case 105: case 121: case 124: case 205: return `${num(value)}%`;
      case 115: return (this.q("SELECT name FROM groups WHERE id = ?").get(value) as any)?.name ?? String(value);
      case 116: return this.typeName(value);
      case 119: return this.attributeDefs().get(value)?.display_name ?? String(value);
      case 137: return value ? "Yes" : "No";
      case 140: return `Level ${value}`;
      case 117: return ({ 1: "Small", 2: "Medium", 3: "Large", 4: "Capital" } as Record<number, string>)[value] ?? String(value);
      case 142: return ({ 1: "Male", 2: "Unisex", 3: "Female" } as Record<number, string>)[value] ?? String(value);
      default: return unit && unit !== "None" ? `${num(value)} ${unit}` : num(value);
    }
  }

  /**
   * Published attributes grouped by category, as { category: { "Display Name": "formatted" } }.
   * Required-skill attributes are excluded (they are reported separately); NULL-category ones are
   * dropped unless listed in keepAttributes.
   */
  describeAttributes(
    typeId: number,
    opts: { only?: number[]; skipCategories?: Set<string>; skipAttributes?: Set<number>; keepAttributes?: Set<number> } = {},
  ): Record<string, Record<string, string>> {
    const defs = this.attributeDefs();
    const out: Record<string, Record<string, string>> = {};
    const skillAttrs = new Set(REQUIRED_SKILL_ATTRS.flat());
    for (const [id, value] of this.typeAttributes(typeId)) {
      if (opts.only && !opts.only.includes(id)) continue;
      const def = defs.get(id);
      if (!def || !def.published || !def.display_name || skillAttrs.has(id)) continue;
      if (opts.skipAttributes?.has(id)) continue;
      let cat = this.attributeCategory(def.category_id);
      if (opts.keepAttributes?.has(id)) cat = cat === "NULL" ? "Miscellaneous" : cat;
      else if (cat === "Graphics" || cat === "NULL" || opts.skipCategories?.has(cat)) continue;
      (out[cat] ??= {})[def.display_name] = this.formatAttribute(id, value);
    }
    return out;
  }

  requiredSkills(typeId: number): Array<{ skill_id: number; level: number }> {
    const attrs = this.typeAttributes(typeId);
    const out: Array<{ skill_id: number; level: number }> = [];
    for (const [s, l] of REQUIRED_SKILL_ATTRS) {
      const skill = attrs.get(s);
      if (skill) out.push({ skill_id: skill, level: attrs.get(l) ?? 1 });
    }
    return out;
  }

  // ---------- blueprints ----------

  blueprint(id: number): { id: number; max_runs: number; activities: any } | null {
    const r = this.q("SELECT * FROM blueprints WHERE id = ?").get(id) as any;
    return r ? { id: r.id, max_runs: r.max_runs, activities: JSON.parse(r.data) } : null;
  }

  blueprintsProducing(productId: number): Array<{ blueprint_id: number; activity: string }> {
    return (this.q("SELECT blueprint_id, activity FROM blueprint_products WHERE product_id = ?").all(productId) as any[]);
  }

  // ---------- universe ----------

  system(id: number): { id: number; name: string; constellation_id: number; region_id: number; security: number; security_class: string | null } | null {
    return (this.q("SELECT * FROM systems WHERE id = ?").get(id) as any) ?? null;
  }

  systemSummary(id: number) {
    const s = this.system(id);
    if (!s) return null;
    return {
      id: s.id,
      name: s.name,
      security: displaySecurity(s.security),
      security_band: s.region_id >= 11000000 ? "wormhole" : securityBand(s.security),
      constellation: this.constellationName(s.constellation_id),
      region: this.regionName(s.region_id),
    };
  }

  systemIdByName(name: string): number | null {
    return ((this.q("SELECT id FROM systems WHERE name = ? COLLATE NOCASE").get(name.trim()) as any)?.id) ?? null;
  }

  searchSystems(query: string, limit = 10): number[] {
    const q = query.trim();
    return (this.q(`SELECT id FROM systems WHERE name LIKE ? ORDER BY (name = ? COLLATE NOCASE) DESC,
      (name LIKE ?) DESC, length(name) LIMIT ?`).all(`%${q}%`, q, `${q}%`, limit) as any[]).map((r) => r.id);
  }

  regionName(id: number): string | null {
    return ((this.q("SELECT name FROM regions WHERE id = ?").get(id) as any)?.name) ?? null;
  }

  regionIdByName(name: string): number | null {
    return ((this.q("SELECT id FROM regions WHERE name = ? COLLATE NOCASE").get(name.trim()) as any)?.id) ?? null;
  }

  searchRegions(query: string, limit = 10): number[] {
    return (this.q("SELECT id FROM regions WHERE name LIKE ? ORDER BY length(name) LIMIT ?").all(`%${query.trim()}%`, limit) as any[]).map((r) => r.id);
  }

  constellationName(id: number): string | null {
    return ((this.q("SELECT name FROM constellations WHERE id = ?").get(id) as any)?.name) ?? null;
  }

  constellationIdByName(name: string): number | null {
    return ((this.q("SELECT id FROM constellations WHERE name = ? COLLATE NOCASE").get(name.trim()) as any)?.id) ?? null;
  }

  neighbours(systemId: number): number[] {
    return (this.q("SELECT to_id FROM system_jumps WHERE from_id = ?").all(systemId) as any[]).map((r) => r.to_id);
  }

  station(id: number): { id: number; name: string; system_id: number; type_id: number; owner_id: number } | null {
    return (this.q("SELECT * FROM stations WHERE id = ?").get(id) as any) ?? null;
  }

  stationsInSystem(systemId: number): Array<{ id: number; name: string }> {
    return this.q("SELECT id, name FROM stations WHERE system_id = ? ORDER BY name").all(systemId) as any[];
  }

  searchStations(query: string, limit = 10): number[] {
    return (this.q("SELECT id FROM stations WHERE name LIKE ? ORDER BY length(name) LIMIT ?").all(`%${query.trim()}%`, limit) as any[]).map((r) => r.id);
  }

  planetName(id: number): string | null {
    const p = this.q("SELECT system_id, celestial_index FROM planets WHERE id = ?").get(id) as any;
    if (!p) return null;
    const sys = this.system(p.system_id);
    return sys ? `${sys.name} ${romanNumeral(p.celestial_index)}` : null;
  }

  planetSystem(id: number): number | null {
    return ((this.q("SELECT system_id FROM planets WHERE id = ?").get(id) as any)?.system_id) ?? null;
  }

  npcCorporationName(id: number): string | null {
    return ((this.q("SELECT name FROM npc_corporations WHERE id = ?").get(id) as any)?.name) ?? null;
  }

  factionName(id: number): string | null {
    return ((this.q("SELECT name FROM factions WHERE id = ?").get(id) as any)?.name) ?? null;
  }

  groupName(id: number): string | null {
    return ((this.q("SELECT name FROM groups WHERE id = ?").get(id) as any)?.name) ?? null;
  }

  /** Breadth-first jump distance through stargates (ignores wormholes/jump bridges). */
  jumpDistances(from: number, maxJumps: number): Map<number, number> {
    const dist = new Map<number, number>([[from, 0]]);
    let frontier = [from];
    for (let d = 1; d <= maxJumps && frontier.length; d++) {
      const next: number[] = [];
      for (const s of frontier) for (const n of this.neighbours(s)) {
        if (!dist.has(n)) { dist.set(n, d); next.push(n); }
      }
      frontier = next;
    }
    return dist;
  }
}

/** Security as shown in game: one decimal, except that 0.0 < sec < 0.05 displays as 0.1. */
export function displaySecurity(sec: number): number {
  if (sec > 0 && sec < 0.05) return 0.1;
  return Math.round(sec * 10) / 10;
}

export function securityBand(sec: number): "highsec" | "lowsec" | "nullsec" {
  const r = displaySecurity(sec);
  if (r >= 0.5) return "highsec";
  if (r > 0.0) return "lowsec";
  return "nullsec";
}

function romanNumeral(n: number): string {
  const map: Array<[number, string]> = [[50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  let out = "";
  for (const [v, s] of map) while (n >= v) { out += s; n -= v; }
  return out;
}

function trigrams(s: string): Set<string> {
  const p = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < p.length - 2; i++) out.add(p.slice(i, i + 3));
  return out;
}

function dice(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return (2 * inter) / (a.size + b.size);
}
