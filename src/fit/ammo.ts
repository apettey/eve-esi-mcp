import { CATEGORY, type Sde } from "../sde/db.js";
import type { Fit, SlotKind } from "./model.js";

/** chargeGroup1..5: the item groups a module can load. */
const CHARGE_GROUP_ATTRS = [604, 605, 606, 609, 610];
/** chargeSize: 1 = small .. 4 = XL; turrets and their ammo carry it, launchers and missiles don't. */
const CHARGE_SIZE = 128;

/** Whether `chargeTypeId` can be loaded into `moduleTypeId` (charge group and, when the module has one, size). */
export function chargeFits(sde: Sde, moduleTypeId: number, chargeTypeId: number): boolean {
  const charge = sde.type(chargeTypeId);
  if (!charge || charge.category_id !== CATEGORY.charge) return false;
  const a = sde.typeAttributes(moduleTypeId);
  const groups = CHARGE_GROUP_ATTRS.map((id) => a.get(id)).filter((g): g is number => g != null);
  if (!groups.includes(charge.group_id)) return false;
  const size = a.get(CHARGE_SIZE);
  return size == null || sde.attr(chargeTypeId, CHARGE_SIZE) === size;
}

/**
 * Returns a copy of the fit with every unloaded turret and launcher given a compatible charge from `cargo` (default the
 * fit's own; the largest stack wins), plus what was assumed. Saved fittings keep ammo in cargo and asset ships often have
 * empty guns, so without this a fitting engine reports 0 weapon DPS. Only meant for the EFT sent to the engine.
 */
export function loadCargoAmmo(
  sde: Sde, fit: Fit, cargo: Fit["cargo"] = fit.cargo,
): { fit: Fit; assumed: string[]; unloaded: string[] } {
  const stacks = new Map<number, number>();
  for (const c of cargo) stacks.set(c.type_id, (stacks.get(c.type_id) ?? 0) + c.quantity);
  const byQuantity = [...stacks.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);

  const out: Fit = { ...fit, slots: { ...fit.slots } };
  const assumed = new Map<string, number>();
  const unloaded = new Map<string, number>();
  const choice = new Map<number, number | null>();
  for (const kind of Object.keys(fit.slots) as SlotKind[]) {
    out.slots[kind] = fit.slots[kind].map((m) => {
      if (!m || m.charge_type_id) return m;
      const hardpoint = sde.type(m.type_id)?.hardpoint;
      if (hardpoint !== "turret" && hardpoint !== "launcher") return m;
      if (!choice.has(m.type_id)) choice.set(m.type_id, byQuantity.find((id) => chargeFits(sde, m.type_id, id)) ?? null);
      const charge = choice.get(m.type_id);
      const name = sde.typeName(m.type_id);
      if (charge == null) {
        unloaded.set(name, (unloaded.get(name) ?? 0) + 1);
        return m;
      }
      const key = `${name}\u0000${sde.typeName(charge)}`;
      assumed.set(key, (assumed.get(key) ?? 0) + 1);
      return { ...m, charge_type_id: charge };
    });
  }
  return {
    fit: out,
    assumed: [...assumed].map(([k, n]) => {
      const [mod, charge] = k.split("\u0000");
      return `${mod} x${n}: ${charge} (from cargo)`;
    }),
    unloaded: [...unloaded].map(([mod, n]) => `no compatible ammo in cargo for ${mod} x${n}`),
  };
}
