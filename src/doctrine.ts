import { ATTR, CATEGORY, type Sde } from "./sde/db.js";
import { type SlotKind, fitFromFlaggedItems, numericFlagToName, parseSlotFlag, shipSlotCounts, toEft } from "./fit/model.js";

/**
 * Doctrine bundles: enemy comps built from killmails, in the shape eve-fit's `save_doctrine(**bundle)` takes.
 * The contract lives in eve-fit-mcp's docs/INTEGRATION.md ("Doctrine bundle"). It is additive-only: don't rename
 * or remove fields, and tell the eve-fit side before adding any.
 */
export interface DoctrineShip {
  ship: string;
  label: string;
  /** Unique pilots seen in this hull, victims and attackers. */
  count: number;
  /** One EFT per loss (fitted modules + loaded charges + drones that fit the bandwidth). Empty: fit unknown. */
  efts: string[];
  weapons_seen?: string[];
  pilots_seen: number;
}

export interface DoctrineBundle {
  name: string;
  description: string;
  source: { type: "zkillboard" | "battle_report"; url: string; kill_ids: number[]; fetched_at: string };
  ships: DoctrineShip[];
}

export interface KmParticipant {
  character_id?: number;
  corporation_id?: number;
  alliance_id?: number;
  ship_type_id?: number;
}

export interface Killmail {
  killmail_id: number;
  killmail_time: string;
  solar_system_id: number;
  victim: KmParticipant & {
    items?: Array<{ item_type_id: number; flag: number; quantity_destroyed?: number; quantity_dropped?: number }>;
  };
  attackers: Array<KmParticipant & { weapon_type_id?: number }>;
}

const CAPSULE_GROUPS = new Set([29]); // Capsule
export const MAX_EFTS_PER_HULL = 20;
const MAX_DRONES_IN_SPACE = 5;

/** Ships only: no capsules, structures, deployables or NPC entities. */
export function isShipHull(sde: Sde, typeId: number | undefined): typeId is number {
  if (!typeId) return false;
  const t = sde.type(typeId);
  return !!t && t.category_id === CATEGORY.ship && !CAPSULE_GROUPS.has(t.group_id);
}

/**
 * EFT of a loss as it was flown: fitted modules and their loaded charges (burst charges included), drones up to the
 * hull's bandwidth and five in space, fighters in launch tubes. Cargo, implants, the rest of the drone bay and
 * anything past the hull's rack sizes are left out, because eve-fit rejects fits that don't fit the hull.
 */
export function lossEft(sde: Sde, km: Killmail): string | null {
  const ship = km.victim.ship_type_id;
  if (!isShipHull(sde, ship)) return null;
  const items = (km.victim.items ?? [])
    .map((i) => ({ type_id: i.item_type_id, flag: numericFlagToName(i.flag), quantity: (i.quantity_destroyed ?? 0) + (i.quantity_dropped ?? 0) || 1 }))
    .filter((i) => sde.type(i.type_id) && (parseSlotFlag(i.flag) || i.flag === "DroneBay" || i.flag.startsWith("FighterTube")));
  const fit = fitFromFlaggedItems(sde, `km ${km.killmail_id}`, ship, items);
  const counts = shipSlotCounts(sde, ship, fit);
  for (const kind of Object.keys(fit.slots) as SlotKind[]) fit.slots[kind] = fit.slots[kind].slice(0, counts[kind]);
  fit.drones = dronesInSpace(sde, ship, fit.drones);
  fit.cargo = [];
  fit.implants = [];
  return toEft(sde, fit);
}

/** The drones a hull could have had out: the biggest stacks first, within bandwidth and the five-drone limit. */
export function dronesInSpace(sde: Sde, shipTypeId: number, bay: Array<{ type_id: number; quantity: number }>) {
  let bandwidth = sde.typeAttributes(shipTypeId).get(ATTR.droneBandwidth) ?? 0;
  let slots = MAX_DRONES_IN_SPACE;
  const out: Array<{ type_id: number; quantity: number }> = [];
  for (const d of [...bay].sort((a, b) => b.quantity - a.quantity)) {
    const bw = sde.typeAttributes(d.type_id).get(ATTR.droneBandwidthUsed) ?? 0;
    const n = Math.min(d.quantity, slots, bw > 0 ? Math.floor(bandwidth / bw + 1e-9) : slots);
    if (n <= 0) continue;
    out.push({ type_id: d.type_id, quantity: n });
    slots -= n;
    bandwidth -= n * bw;
    if (!slots) break;
  }
  return out;
}

export interface BuildOptions {
  name: string;
  description: string;
  source: DoctrineBundle["source"];
  killmails: Killmail[];
  /** Whose pilots belong to this doctrine. */
  isMember: (p: KmParticipant) => boolean;
  /** Pilots known from elsewhere (e.g. a battle report's team list), so hulls without killmail evidence still count. */
  roster?: Array<{ character_id: number; ship_type_id: number }>;
  maxEftsPerHull?: number;
}

/** Groups members' hulls: unique pilots per hull, one EFT per loss, weapons the hull's pilots shot with. */
export function buildDoctrine(sde: Sde, o: BuildOptions): DoctrineBundle {
  const hulls = new Map<number, { pilots: Set<number>; efts: string[]; weapons: Map<string, number> }>();
  const hull = (id: number) => {
    let h = hulls.get(id);
    if (!h) hulls.set(id, (h = { pilots: new Set(), efts: [], weapons: new Map() }));
    return h;
  };
  const cap = o.maxEftsPerHull ?? MAX_EFTS_PER_HULL;
  const seen = new Set<number>();
  for (const km of [...o.killmails].sort((a, b) => Date.parse(b.killmail_time) - Date.parse(a.killmail_time))) {
    if (seen.has(km.killmail_id)) continue;
    seen.add(km.killmail_id);
    const v = km.victim;
    if (v.character_id && isShipHull(sde, v.ship_type_id) && o.isMember(v)) {
      const h = hull(v.ship_type_id);
      h.pilots.add(v.character_id);
      if (h.efts.length < cap) {
        const eft = lossEft(sde, km);
        if (eft) h.efts.push(eft);
      }
    }
    for (const a of km.attackers) {
      if (!a.character_id || !isShipHull(sde, a.ship_type_id) || !o.isMember(a)) continue;
      const h = hull(a.ship_type_id);
      h.pilots.add(a.character_id);
      if (a.weapon_type_id && a.weapon_type_id !== a.ship_type_id && sde.type(a.weapon_type_id)) {
        const w = sde.typeName(a.weapon_type_id);
        h.weapons.set(w, (h.weapons.get(w) ?? 0) + 1);
      }
    }
  }
  for (const r of o.roster ?? []) if (isShipHull(sde, r.ship_type_id)) hull(r.ship_type_id).pilots.add(r.character_id);

  const ships: DoctrineShip[] = [...hulls.entries()]
    .map(([id, h]) => {
      const name = sde.typeName(id);
      const weapons = [...h.weapons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w);
      const count = h.pilots.size;
      const s: DoctrineShip = { ship: name, label: name, count, efts: h.efts, pilots_seen: count };
      if (weapons.length) s.weapons_seen = weapons;
      return s;
    })
    .sort((a, b) => b.count - a.count || b.efts.length - a.efts.length || a.ship.localeCompare(b.ship));
  return { name: o.name, description: o.description, source: o.source, ships };
}

/** One line on what a bundle holds, for descriptions: "12 pilots in 5 hulls (Nighthawk x8, ...); 9 fits from losses". */
export function compSummary(ships: DoctrineShip[]): string {
  const pilots = ships.reduce((n, s) => n + s.count, 0);
  const fits = ships.reduce((n, s) => n + s.efts.length, 0);
  const top = ships.slice(0, 6).map((s) => `${s.ship} x${s.count}`).join(", ");
  return `${pilots} pilot-hulls in ${ships.length} hull types (${top}${ships.length > 6 ? ", ..." : ""}); ${fits} fits from losses`;
}
