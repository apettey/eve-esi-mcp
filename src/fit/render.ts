import { ATTR, CATEGORY, type Sde } from "../sde/db.js";
import { describeRequirements, requirementClosure, skillGaps, type CharacterSkills } from "../skills.js";
import { round } from "../util.js";
import { shipSlotCounts, toDna, toEft, type Fit, type SlotKind } from "./model.js";

export type AttributeDetail = "none" | "summary" | "full";

/** Attribute categories that are noise for most fitting questions. */
const SUMMARY_SKIP_CATEGORIES = new Set([
  "Heat", "AI", "Entity Rewards", "Entity Extra Attributes", "Loot", "On Death", "Behavior Attributes", "Other",
]);
/** Tech/meta level are reported as top-level fields already. */
const SUMMARY_SKIP_ATTRIBUTES = new Set<number>([ATTR.techLevel, ATTR.metaLevel]);
/** Uncategorised but useful: max modules of group fitted/active. */
const SUMMARY_KEEP_ATTRIBUTES = new Set<number>([1544, 763]);

const SHIP_SUMMARY_ATTRS = [
  ATTR.hiSlots, ATTR.medSlots, ATTR.lowSlots, ATTR.rigSlots, ATTR.turretHardpoints, ATTR.launcherHardpoints,
  ATTR.cpuOutput, ATTR.powerOutput, ATTR.calibration, ATTR.rigSize, ATTR.capacitorCapacity, ATTR.rechargeRate,
  ATTR.shieldCapacity, ATTR.shieldRechargeRate, ATTR.armorHP, ATTR.hp,
  ATTR.shieldEm, ATTR.shieldThermal, ATTR.shieldKinetic, ATTR.shieldExplosive,
  ATTR.armorEm, ATTR.armorThermal, ATTR.armorKinetic, ATTR.armorExplosive,
  ATTR.hullEm, ATTR.hullThermal, ATTR.hullKinetic, ATTR.hullExplosive,
  ATTR.maxVelocity, ATTR.agility, ATTR.warpSpeed, ATTR.signatureRadius, ATTR.maxTargetRange, ATTR.scanResolution,
  ATTR.maxLockedTargets, ATTR.droneCapacity, ATTR.droneBandwidth,
];

const CPU_MANAGEMENT = 3426;
const POWER_GRID_MANAGEMENT = 3413;

export function describeShipBonuses(sde: Sde, shipTypeId: number) {
  const b = sde.typeBonus(shipTypeId);
  if (!b) return undefined;
  const fmt = (x: any) => (x.bonus != null ? `${round(x.bonus, 2)}${x.unit_id === 105 || x.unit_id == null ? "%" : ""} ${x.text}` : x.text);
  const out: Record<string, string[]> = {};
  for (const s of b.skills ?? []) out[`${sde.typeName(s.skill_id)} (per level)`] = s.bonuses.map(fmt);
  if (b.role?.length) out["Role bonus"] = b.role.map(fmt);
  if (b.misc?.length) out["Misc"] = b.misc.map(fmt);
  return out;
}

export function moduleAttributes(sde: Sde, typeId: number, detail: AttributeDetail) {
  if (detail === "none") return undefined;
  if (detail === "full") return sde.describeAttributes(typeId, { keepAttributes: SUMMARY_KEEP_ATTRIBUTES });
  const skip = new Set(SUMMARY_SKIP_ATTRIBUTES);
  // A module's own structure HP is irrelevant once fitted; ships keep theirs.
  if (sde.type(typeId)?.category_id !== CATEGORY.ship) skip.add(ATTR.hp);
  return sde.describeAttributes(typeId, {
    skipCategories: SUMMARY_SKIP_CATEGORIES,
    skipAttributes: skip,
    keepAttributes: SUMMARY_KEEP_ATTRIBUTES,
  });
}

/**
 * Produces a self-contained description of a fit: named slots, resource usage, ship stats and bonuses,
 * per-module attributes, skill check against a character, plus EFT and DNA exports.
 */
export function renderFit(sde: Sde, fit: Fit, opts: { detail?: AttributeDetail; skills?: CharacterSkills; characterName?: string } = {}) {
  const detail = opts.detail ?? "summary";
  const ship = sde.type(fit.ship_type_id);
  const counts = shipSlotCounts(sde, fit.ship_type_id, fit);
  const shipAttrs = sde.typeAttributes(fit.ship_type_id);

  const slots: Record<string, Array<{ slot: string; module: string; charge?: string; offline?: boolean }>> = {};
  let cpu = 0, pg = 0, cal = 0, turrets = 0, launchers = 0;
  const moduleCounts = new Map<number, number>();
  const chargeIds = new Set<number>();
  for (const kind of ["high", "med", "low", "rig", "subsystem", "service"] as SlotKind[]) {
    const total = Math.max(counts[kind], fit.slots[kind].length);
    if (!total) continue;
    slots[kind] = [];
    for (let i = 0; i < total; i++) {
      const m = fit.slots[kind][i];
      if (!m) { slots[kind].push({ slot: `${kind}:${i}`, module: "(empty)" }); continue; }
      const a = sde.typeAttributes(m.type_id);
      if (!m.offline) { cpu += a.get(ATTR.cpu) ?? 0; pg += a.get(ATTR.power) ?? 0; }
      cal += a.get(ATTR.upgradeCost) ?? 0;
      const t = sde.type(m.type_id);
      if (t?.hardpoint === "turret") turrets++;
      if (t?.hardpoint === "launcher") launchers++;
      moduleCounts.set(m.type_id, (moduleCounts.get(m.type_id) ?? 0) + 1);
      if (m.charge_type_id) chargeIds.add(m.charge_type_id);
      slots[kind].push({
        slot: `${kind}:${i}`,
        module: sde.typeName(m.type_id),
        ...(m.charge_type_id ? { charge: sde.typeName(m.charge_type_id) } : {}),
        ...(m.offline ? { offline: true } : {}),
      });
    }
  }

  const cpuOut = shipAttrs.get(ATTR.cpuOutput) ?? 0;
  const pgOut = shipAttrs.get(ATTR.powerOutput) ?? 0;
  const calOut = shipAttrs.get(ATTR.calibration) ?? 0;
  const bandwidthOut = shipAttrs.get(ATTR.droneBandwidth) ?? 0;
  const droneBay = shipAttrs.get(ATTR.droneCapacity) ?? 0;
  let bandwidth = 0, droneVolume = 0;
  for (const d of fit.drones) {
    bandwidth += (sde.attr(d.type_id, ATTR.droneBandwidthUsed) ?? 0) * d.quantity;
    droneVolume += (sde.type(d.type_id)?.volume ?? 0) * d.quantity;
  }
  const cargoVolume = fit.cargo.reduce((s, c) => s + (sde.type(c.type_id)?.volume ?? 0) * c.quantity, 0);
  const subsystemTurrets = fit.slots.subsystem.reduce((s, m) => s + (m ? sde.attr(m.type_id, 1368) ?? 0 : 0), 0);
  const subsystemLaunchers = fit.slots.subsystem.reduce((s, m) => s + (m ? sde.attr(m.type_id, 1369) ?? 0 : 0), 0);

  const res = (used: number, out: number, unit: string) => ({
    used: `${round(used, 2)}${unit ? " " + unit : ""}`,
    available: `${round(out, 2)}${unit ? " " + unit : ""}`,
    percent: out ? round((used / out) * 100, 1) : null,
  });
  const skill = (id: number) => opts.skills?.levels.get(id)?.active ?? 0;
  const resources: Record<string, unknown> = {
    note:
      "Base values from static data: no skills, rigs or module bonuses applied, so CPU/PG above 100% here is common for fits that " +
      "work in game (skills like CPU Management and Weapon Upgrades cut usage substantially). Use a fitting engine (e.g. Pyfa) with the EFT for exact stats.",
    cpu: res(cpu, cpuOut, "tf"),
    powergrid: res(pg, pgOut, "MW"),
    calibration: res(cal, calOut, ""),
    turret_hardpoints: `${turrets}/${(shipAttrs.get(ATTR.turretHardpoints) ?? 0) + subsystemTurrets}`,
    launcher_hardpoints: `${launchers}/${(shipAttrs.get(ATTR.launcherHardpoints) ?? 0) + subsystemLaunchers}`,
  };
  if (bandwidthOut || fit.drones.length) {
    resources.drone_bandwidth = res(bandwidth, bandwidthOut, "Mbit/s");
    resources.drone_bay = res(droneVolume, droneBay, "m3");
  }
  if (fit.cargo.length) resources.cargo = res(cargoVolume, ship?.capacity ?? 0, "m3");
  if (opts.skills) {
    const cpuSkilled = cpuOut * (1 + 0.05 * skill(CPU_MANAGEMENT));
    const pgSkilled = pgOut * (1 + 0.05 * skill(POWER_GRID_MANAGEMENT));
    resources.with_character_core_skills = {
      note: `${opts.characterName ?? "Character"}'s CPU Management / Power Grid Management applied to ship output only.`,
      cpu: res(cpu, cpuSkilled, "tf"),
      powergrid: res(pg, pgSkilled, "MW"),
    };
  }

  const allTypes = [
    fit.ship_type_id,
    ...moduleCounts.keys(),
    ...chargeIds,
    ...fit.drones.map((d) => d.type_id),
    ...fit.fighters.map((d) => d.type_id),
  ];
  const required = requirementClosure(sde, allTypes);
  const skillCheck = opts.skills ? skillGaps(sde, required, opts.skills) : undefined;

  const modules = [...moduleCounts.entries()].map(([id, count]) => {
    const t = sde.type(id)!;
    const a = sde.typeAttributes(id);
    return {
      name: t.name,
      type_id: id,
      count,
      slot: t.slot,
      group: t.group,
      meta_group: t.meta_group,
      cpu: a.get(ATTR.cpu) ?? 0,
      powergrid: a.get(ATTR.power) ?? 0,
      ...(a.get(ATTR.upgradeCost) ? { calibration: a.get(ATTR.upgradeCost) } : {}),
      required_skills: describeRequirements(sde, id, opts.skills),
      attributes: moduleAttributes(sde, id, detail),
    };
  });
  const extras = [...chargeIds, ...fit.drones.map((d) => d.type_id), ...fit.fighters.map((d) => d.type_id)].map((id) => {
    const t = sde.type(id)!;
    return {
      name: t.name,
      type_id: id,
      kind: t.category_id === CATEGORY.charge ? "charge" : t.category_id === CATEGORY.drone ? "drone" : "fighter",
      group: t.group,
      required_skills: describeRequirements(sde, id, opts.skills),
      attributes: moduleAttributes(sde, id, detail),
    };
  });

  const shipStats: Record<string, string> = {};
  const defs = sde.attributeDefs();
  for (const id of SHIP_SUMMARY_ATTRS) {
    const v = shipAttrs.get(id);
    const def = defs.get(id);
    if (v != null && def?.display_name) shipStats[def.display_name] = sde.formatAttribute(id, v);
  }
  if (ship?.capacity) shipStats["Cargo Capacity"] = `${ship.capacity} m3`;

  return {
    name: fit.name,
    ...(fit.description ? { description: fit.description } : {}),
    ship: {
      name: ship?.name,
      type_id: fit.ship_type_id,
      group: ship?.group,
      meta_group: ship?.meta_group,
      stats: shipStats,
      bonuses: describeShipBonuses(sde, fit.ship_type_id),
      required_skills: describeRequirements(sde, fit.ship_type_id, opts.skills),
      ...(detail === "full" ? { attributes: sde.describeAttributes(fit.ship_type_id) } : {}),
    },
    slots,
    drones: fit.drones.map((d) => ({ name: sde.typeName(d.type_id), quantity: d.quantity })),
    fighters: fit.fighters.map((d) => ({ name: sde.typeName(d.type_id), quantity: d.quantity })),
    implants: fit.implants.map((i) => sde.typeName(i)),
    cargo: fit.cargo.map((c) => ({ name: sde.typeName(c.type_id), quantity: c.quantity })),
    resources,
    modules,
    charges_and_drones: extras,
    skill_check: skillCheck
      ? { character: opts.characterName, ...skillCheck }
      : { note: "Pass a character (or log one in) to check skills.", skills_required: [...required].map(([id, l]) => `${sde.typeName(id)} ${l}`) },
    eft: toEft(sde, fit),
    dna: toDna(fit),
  };
}
