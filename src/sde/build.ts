import { createWriteStream, existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import yauzl from "yauzl";
import { SDE_LATEST_URL, SDE_ZIP_URL } from "../config.js";
import { log } from "../util.js";

/**
 * Builds a compact SQLite index from CCP's official JSONL Static Data Export.
 * Only the datasets the tools need are imported; localized strings keep English only.
 */

export const SDE_SCHEMA_VERSION = 4;

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT, published INTEGER);
CREATE TABLE groups (id INTEGER PRIMARY KEY, category_id INTEGER, name TEXT, published INTEGER);
CREATE TABLE market_groups (id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT);
CREATE TABLE meta_groups (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE types (
  id INTEGER PRIMARY KEY, name TEXT, group_id INTEGER, published INTEGER, market_group_id INTEGER,
  meta_group_id INTEGER, meta_level INTEGER, tech_level INTEGER, volume REAL, packaged_volume REAL,
  capacity REAL, mass REAL, base_price REAL, portion_size INTEGER, variation_parent_id INTEGER,
  faction_id INTEGER, race_id INTEGER, description TEXT, slot TEXT, hardpoint TEXT
);
CREATE INDEX types_name ON types (name COLLATE NOCASE);
CREATE INDEX types_group ON types (group_id);
CREATE INDEX types_variation ON types (variation_parent_id);
CREATE TABLE type_attributes (type_id INTEGER, attribute_id INTEGER, value REAL, PRIMARY KEY (type_id, attribute_id)) WITHOUT ROWID;
CREATE TABLE type_bonus (type_id INTEGER PRIMARY KEY, data TEXT);
CREATE TABLE attributes (
  id INTEGER PRIMARY KEY, name TEXT, display_name TEXT, description TEXT, category_id INTEGER,
  unit_id INTEGER, published INTEGER, high_is_good INTEGER, default_value REAL
);
CREATE TABLE attribute_categories (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE units (id INTEGER PRIMARY KEY, name TEXT, display_name TEXT);
CREATE TABLE regions (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE constellations (id INTEGER PRIMARY KEY, name TEXT, region_id INTEGER);
CREATE TABLE systems (
  id INTEGER PRIMARY KEY, name TEXT, constellation_id INTEGER, region_id INTEGER,
  security REAL, security_class TEXT, wormhole_class_id INTEGER, effect_beacon_id INTEGER, visual_effect TEXT
);
CREATE INDEX systems_name ON systems (name COLLATE NOCASE);
CREATE TABLE system_jumps (from_id INTEGER, to_id INTEGER, PRIMARY KEY (from_id, to_id)) WITHOUT ROWID;
CREATE TABLE planets (id INTEGER PRIMARY KEY, system_id INTEGER, celestial_index INTEGER, type_id INTEGER);
CREATE TABLE stations (id INTEGER PRIMARY KEY, name TEXT, system_id INTEGER, type_id INTEGER, owner_id INTEGER);
CREATE INDEX stations_name ON stations (name COLLATE NOCASE);
CREATE INDEX stations_system ON stations (system_id);
CREATE TABLE npc_corporations (id INTEGER PRIMARY KEY, name TEXT, faction_id INTEGER);
CREATE TABLE factions (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE blueprints (id INTEGER PRIMARY KEY, max_runs INTEGER, data TEXT);
CREATE TABLE blueprint_products (product_id INTEGER, blueprint_id INTEGER, activity TEXT);
CREATE INDEX blueprint_products_product ON blueprint_products (product_id);
`;

const EFFECT_SLOTS: Record<number, string> = {
  11: "low",
  12: "high",
  13: "med",
  2663: "rig",
  3772: "subsystem",
  6306: "service",
};

type Row = Record<string, any>;

function en(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object" && "en" in (v as Row)) return (v as Row).en ?? null;
  return null;
}

/** Converts `[{_key, _value}]` lists back into plain pairs. */
function kv(list: unknown): Array<[number, any]> {
  if (!Array.isArray(list)) return [];
  return list.map((e: Row) => [e._key, "_value" in e ? e._value : e]);
}

function stripTags(s: string | null): string | null {
  return s == null ? null : s.replace(/<[^>]+>/g, "");
}

const ROMAN: Array<[number, string]> = [
  [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
];
export function roman(n: number): string {
  let out = "";
  for (const [v, s] of ROMAN) while (n >= v) { out += s; n -= v; }
  return out;
}

export async function fetchLatestBuild(userAgent: string): Promise<number> {
  const res = await fetch(SDE_LATEST_URL, { headers: { "User-Agent": userAgent } });
  if (!res.ok) throw new Error(`SDE version check failed: HTTP ${res.status}`);
  for (const line of (await res.text()).split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    if (rec._key === "sde") return rec.buildNumber;
  }
  throw new Error("SDE version check: no 'sde' record");
}

async function download(url: string, dest: string, userAgent: string): Promise<void> {
  const res = await fetch(url, { headers: { "User-Agent": userAgent } });
  if (!res.ok || !res.body) throw new Error(`SDE download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(dest));
}

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) =>
    yauzl.open(path, { lazyEntries: true, autoClose: false }, (err, zip) => (err ? reject(err) : resolve(zip!))),
  );
}

async function zipEntries(zip: yauzl.ZipFile): Promise<Map<string, yauzl.Entry>> {
  const entries = new Map<string, yauzl.Entry>();
  await new Promise<void>((resolve, reject) => {
    zip.on("entry", (e: yauzl.Entry) => { entries.set(e.fileName.replace(/^.*\//, ""), e); zip.readEntry(); });
    zip.on("end", () => resolve());
    zip.on("error", reject);
    zip.readEntry();
  });
  return entries;
}

async function eachLine(zip: yauzl.ZipFile, entries: Map<string, yauzl.Entry>, name: string, fn: (r: Row) => void) {
  const entry = entries.get(name);
  if (!entry) throw new Error(`SDE archive is missing ${name}`);
  const stream = await new Promise<Readable>((resolve, reject) =>
    zip.openReadStream(entry, (err, s) => (err ? reject(err) : resolve(s!))),
  );
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) if (line) fn(JSON.parse(line));
}

export async function buildSde(home: string, build: number, userAgent: string): Promise<string> {
  const zipPath = join(home, `sde-${build}.zip`);
  const dbPath = join(home, `sde-${build}.sqlite`);
  const tmpPath = dbPath + ".tmp";
  if (!existsSync(zipPath) || statSync(zipPath).size === 0) {
    log(`Downloading SDE build ${build} (~100 MB)...`);
    await download(SDE_ZIP_URL(build), zipPath + ".part", userAgent);
    rmSync(zipPath, { force: true });
    renameSync(zipPath + ".part", zipPath);
  }
  log(`Indexing SDE build ${build}...`);
  rmSync(tmpPath, { force: true });
  const db = new DatabaseSync(tmpPath);
  db.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;");
  db.exec(SCHEMA);
  const zip = await openZip(zipPath);
  try {
    const entries = await zipEntries(zip);
    db.exec("BEGIN");
    const ins = (sql: string) => db.prepare(sql);

    const cat = ins("INSERT INTO categories VALUES (?,?,?)");
    await eachLine(zip, entries, "categories.jsonl", (r) => cat.run(r._key, en(r.name), r.published ? 1 : 0));

    const grp = ins("INSERT INTO groups VALUES (?,?,?,?)");
    await eachLine(zip, entries, "groups.jsonl", (r) => grp.run(r._key, r.categoryID, en(r.name), r.published ? 1 : 0));

    const mg = ins("INSERT INTO market_groups VALUES (?,?,?)");
    await eachLine(zip, entries, "marketGroups.jsonl", (r) => mg.run(r._key, r.parentGroupID ?? null, en(r.name)));

    const meta = ins("INSERT INTO meta_groups VALUES (?,?)");
    await eachLine(zip, entries, "metaGroups.jsonl", (r) => meta.run(r._key, en(r.name)));

    // Slot and hardpoint come from dogma effects; collect them before inserting types.
    const slots = new Map<number, string>();
    const hardpoints = new Map<number, string>();
    const ta = ins("INSERT INTO type_attributes VALUES (?,?,?)");
    await eachLine(zip, entries, "typeDogma.jsonl", (r) => {
      for (const a of r.dogmaAttributes ?? []) ta.run(r._key, a.attributeID, a.value);
      for (const e of r.dogmaEffects ?? []) {
        const slot = EFFECT_SLOTS[e.effectID];
        if (slot) slots.set(r._key, slot);
        if (e.effectID === 42) hardpoints.set(r._key, "turret");
        if (e.effectID === 40) hardpoints.set(r._key, "launcher");
      }
    });

    const ty = ins("INSERT INTO types VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    await eachLine(zip, entries, "types.jsonl", (r) =>
      ty.run(
        r._key, en(r.name), r.groupID, r.published ? 1 : 0, r.marketGroupID ?? null,
        r.metaGroupID ?? null, r.metaLevel ?? null, r.techLevel ?? null, r.volume ?? null,
        r.packagedVolume ?? null, r.capacity ?? null, r.mass ?? null, r.basePrice ?? null,
        r.portionSize ?? 1, r.variationParentTypeID ?? null, r.factionID ?? null, r.raceID ?? null,
        r.published ? en(r.description) : null, slots.get(r._key) ?? null, hardpoints.get(r._key) ?? null,
      ),
    );

    const tb = ins("INSERT INTO type_bonus VALUES (?,?)");
    await eachLine(zip, entries, "typeBonus.jsonl", (r) => {
      const conv = (b: Row) => ({ bonus: b.bonus ?? null, unit_id: b.unitID ?? null, text: stripTags(en(b.bonusText)) });
      const data = {
        skills: kv(r.types).map(([skill, list]) => ({ skill_id: skill, bonuses: (list as Row[]).map(conv) })),
        role: (r.roleBonuses ?? []).map(conv),
        misc: (r.miscBonuses ?? []).map(conv),
      };
      tb.run(r._key, JSON.stringify(data));
    });

    const at = ins("INSERT INTO attributes VALUES (?,?,?,?,?,?,?,?,?)");
    await eachLine(zip, entries, "dogmaAttributes.jsonl", (r) =>
      at.run(
        r._key, r.name, en(r.displayName), en(r.description) ?? null, r.attributeCategoryID ?? null,
        r.unitID ?? null, r.published ? 1 : 0, r.highIsGood ? 1 : 0, r.defaultValue ?? 0,
      ),
    );
    const ac = ins("INSERT INTO attribute_categories VALUES (?,?)");
    await eachLine(zip, entries, "dogmaAttributeCategories.jsonl", (r) => ac.run(r._key, r.name));
    const un = ins("INSERT INTO units VALUES (?,?,?)");
    await eachLine(zip, entries, "dogmaUnits.jsonl", (r) => un.run(r._key, en(r.name), en(r.displayName)));

    // Wormhole class sits on the system, else its constellation, else its region.
    const regionClass = new Map<number, number>();
    const constellationClass = new Map<number, number>();
    const rg = ins("INSERT INTO regions VALUES (?,?)");
    await eachLine(zip, entries, "mapRegions.jsonl", (r) => {
      if (r.wormholeClassID != null) regionClass.set(r._key, r.wormholeClassID);
      rg.run(r._key, en(r.name));
    });
    const co = ins("INSERT INTO constellations VALUES (?,?,?)");
    await eachLine(zip, entries, "mapConstellations.jsonl", (r) => {
      if (r.wormholeClassID != null) constellationClass.set(r._key, r.wormholeClassID);
      co.run(r._key, en(r.name), r.regionID);
    });
    // Wormhole system effects (Pulsar, Magnetar, ...) are secondary suns carrying an effect beacon type.
    const beacons = new Map<number, number>();
    await eachLine(zip, entries, "mapSecondarySuns.jsonl", (r) => beacons.set(r.solarSystemID, r.effectBeaconTypeID));
    const sys = ins("INSERT INTO systems VALUES (?,?,?,?,?,?,?,?,?)");
    const systemNames = new Map<number, string>();
    await eachLine(zip, entries, "mapSolarSystems.jsonl", (r) => {
      systemNames.set(r._key, en(r.name)!);
      const whClass = r.wormholeClassID ?? constellationClass.get(r.constellationID) ?? regionClass.get(r.regionID) ?? null;
      sys.run(
        r._key, en(r.name), r.constellationID, r.regionID, r.securityStatus ?? null, r.securityClass ?? null,
        whClass, beacons.get(r._key) ?? null, r.visualEffect ?? null,
      );
    });
    const jumps = ins("INSERT OR IGNORE INTO system_jumps VALUES (?,?)");
    await eachLine(zip, entries, "mapStargates.jsonl", (r) => jumps.run(r.solarSystemID, r.destination.solarSystemID));
    const pl = ins("INSERT INTO planets VALUES (?,?,?,?)");
    await eachLine(zip, entries, "mapPlanets.jsonl", (r) => pl.run(r._key, r.solarSystemID, r.celestialIndex ?? null, r.typeID ?? null));

    const fa = ins("INSERT INTO factions VALUES (?,?)");
    await eachLine(zip, entries, "factions.jsonl", (r) => fa.run(r._key, en(r.name)));
    const corpNames = new Map<number, string>();
    const nc = ins("INSERT INTO npc_corporations VALUES (?,?,?)");
    await eachLine(zip, entries, "npcCorporations.jsonl", (r) => {
      corpNames.set(r._key, en(r.name)!);
      nc.run(r._key, en(r.name), r.factionID ?? null);
    });
    const operations = new Map<number, string>();
    await eachLine(zip, entries, "stationOperations.jsonl", (r) => operations.set(r._key, en(r.operationName)!));
    // NPC station names are not in the SDE; they follow "<System> <Planet>[ - Moon <n>] - <Corp>[ <Operation>]".
    const st = ins("INSERT INTO stations VALUES (?,?,?,?,?)");
    await eachLine(zip, entries, "npcStations.jsonl", (r) => {
      let name = `${systemNames.get(r.solarSystemID)} ${roman(r.celestialIndex ?? 0)}`;
      if (r.orbitIndex) name += ` - Moon ${r.orbitIndex}`;
      name += ` - ${corpNames.get(r.ownerID)}`;
      if (r.useOperationName && operations.get(r.operationID)) name += ` ${operations.get(r.operationID)}`;
      st.run(r._key, name, r.solarSystemID, r.typeID, r.ownerID);
    });

    const bp = ins("INSERT INTO blueprints VALUES (?,?,?)");
    const bpp = ins("INSERT INTO blueprint_products VALUES (?,?,?)");
    await eachLine(zip, entries, "blueprints.jsonl", (r) => {
      bp.run(r._key, r.maxProductionLimit ?? null, JSON.stringify(r.activities ?? {}));
      for (const [activity, a] of Object.entries<Row>(r.activities ?? {}))
        for (const p of a.products ?? []) bpp.run(p.typeID, r._key, activity);
    });

    const m = ins("INSERT INTO meta VALUES (?,?)");
    m.run("build", String(build));
    m.run("schema", String(SDE_SCHEMA_VERSION));
    m.run("built_at", new Date().toISOString());
    db.exec("COMMIT");
    db.exec("ANALYZE");
  } catch (err) {
    db.close();
    rmSync(tmpPath, { force: true });
    throw err;
  } finally {
    zip.close();
  }
  db.close();
  renameSync(tmpPath, dbPath);
  rmSync(zipPath, { force: true });
  log(`SDE build ${build} ready.`);
  return dbPath;
}

/** Removes SDE databases and archives other than the one in use. */
export function cleanupOldSde(home: string, keep: string) {
  for (const f of readdirSync(home)) {
    if (/^sde-\d+\.(sqlite|zip)(\.tmp|\.part)?$/.test(f) && join(home, f) !== keep) {
      try { rmSync(join(home, f), { force: true }); } catch { /* in use on Windows; retry next start */ }
    }
  }
}
