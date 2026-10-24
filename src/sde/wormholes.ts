import { round } from "../util.js";

/** Solar systems in these regions are J-space (11000000-11999999); abyssal space starts at 12000000. */
export function isWormholeRegion(regionId: number): boolean {
  return regionId >= 11000000 && regionId < 12000000;
}

/** Wormhole group in the SDE (types named "Wormhole <code>"). */
export const WORMHOLE_GROUP = 988;

/** Dogma attributes on wormhole types. */
export const WH_ATTR = {
  targetClass: 1381,
  maxStableTime: 1382, // minutes
  maxStableMass: 1383, // kg
  massRegeneration: 1384, // kg
  maxJumpMass: 1385, // kg
} as const;

/** SDE `wormholeClassID` values; the same encoding is used for a wormhole's target class. */
const CLASS_NAMES: Record<number, string> = {
  [-1]: "known space (varies)",
  1: "C1", 2: "C2", 3: "C3", 4: "C4", 5: "C5", 6: "C6",
  7: "highsec", 8: "lowsec", 9: "nullsec",
  12: "Thera", 13: "C13 (shattered, frigate-size only)",
  14: "Drifter (Sentinel)", 15: "Drifter (Barbican)", 16: "Drifter (Vidette)", 17: "Drifter (Conflux)", 18: "Drifter (Redoubt)",
  19: "Abyssal", 20: "Abyssal", 21: "Abyssal", 22: "Abyssal", 23: "Abyssal",
  25: "Pochven",
};

export function wormholeClassName(id: number | null | undefined): string | null {
  if (id == null) return null;
  return CLASS_NAMES[id] ?? `class ${id}`;
}

/**
 * Effect beacon attributes -> readable label. Multipliers show as a percent change; the resistance
 * "bonuses" raise damage resonance, i.e. the ship takes that much more damage of that type.
 */
const EFFECT_LABELS: Record<string, string> = {
  shieldCapacityMultiplier: "Shield HP",
  armorHPMultiplier: "Armor HP",
  signatureRadiusMultiplier: "Signature radius",
  rechargeRateMultiplier: "Capacitor recharge time",
  capacitorCapacityMultiplierSystem: "Capacitor capacity",
  energyWarfareStrengthMultiplier: "Energy neutralizer and nosferatu amount",
  energyTransferAmountBonus: "Remote capacitor transfer amount",
  agilityMultiplier: "Ship inertia (agility)",
  maxVelocityMultiplier: "Ship max velocity",
  maxTargetRangeMultiplier: "Targeting range",
  stasisWebStrengthMultiplier: "Stasis webifier strength",
  missileVelocityMultiplier: "Missile velocity",
  aoeVelocityMultiplier: "Missile explosion velocity",
  aoeCloudSizeMultiplier: "Missile explosion radius",
  damageMultiplierMultiplier: "Turret and missile damage",
  trackingSpeedMultiplier: "Turret tracking",
  targetPainterStrengthMultiplier: "Target painter strength",
  smallWeaponDamageMultiplier: "Small energy turret and rocket damage",
  heatDamageMultiplier: "Overheat damage to modules",
  overloadBonusMultiplier: "Overheat bonus",
  empFieldRangeMultiplier: "Smart bomb range",
  smartbombDamageMultiplier: "Smart bomb and bomb damage",
  armorDamageAmountMultiplier: "Local armor repair amount",
  shieldBonusMultiplier: "Local shield boost amount",
  armorDamageAmountMultiplierRemote: "Remote armor repair amount",
  shieldBonusMultiplierRemote: "Remote shield repair amount",
};

const pct = (v: number) => `${v >= 0 ? "+" : ""}${round(v, 1)}%`;

/** Turns an effect beacon's dogma attributes into readable modifiers, e.g. "Shield HP: +86%". */
export function describeEffectModifiers(attrs: Array<{ name: string; display_name: string | null; value: number }>): string[] {
  const out = new Map<string, string>();
  for (const a of attrs) {
    const resist = /^(armor|shield)\w+DamageResistanceBonus$/.exec(a.name);
    if (resist) {
      // All four damage types share one value per layer; collapse them.
      out.set(`${resist[1]} damage taken (all damage types)`, pct(a.value));
    } else if (EFFECT_LABELS[a.name]) {
      out.set(EFFECT_LABELS[a.name], pct((a.value - 1) * 100));
    } else {
      out.set(a.display_name ?? a.name, String(a.value));
    }
  }
  return [...out].map(([label, v]) => `${label.charAt(0).toUpperCase()}${label.slice(1)}: ${v}`);
}

/** "Class 5 Pulsar Effects" -> "Pulsar". */
export function effectName(beaconName: string): string {
  return beaconName.replace(/^Class \d+ /, "").replace(/ Effects$/, "").replace("Wolf Rayet", "Wolf-Rayet");
}

/** 2_000_000_000 -> "2b kg". */
export function massText(kg: number): string {
  if (kg >= 1e9) return `${round(kg / 1e9, 2)}b kg`;
  if (kg >= 1e6) return `${round(kg / 1e6, 2)}m kg`;
  return `${kg} kg`;
}

/** Normalises "h296", "Wormhole H296" or "H296 - C5" to "H296". */
export function wormholeCode(ref: string): string | null {
  const m = /^\s*(?:wormhole\s+)?([a-z]\d{3})\b/i.exec(ref);
  return m ? m[1].toUpperCase() : null;
}
