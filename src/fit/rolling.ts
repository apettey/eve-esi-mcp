import { ATTR, type Sde } from "../sde/db.js";
import { massText } from "../sde/wormholes.js";
import { round } from "../util.js";
import type { Fit, FittedModule } from "./model.js";

const PROPULSION_GROUP = 46;
const MASS_ADDITION = 796;
const SIGNATURE_RADIUS_BONUS = 554; // only microwarpdrives bloom signature
const MASS_BONUS_PERCENTAGE = 1131; // Higgs Anchor rigs

/** Typical T2 modules per prop size class, keyed by mass added, for advice text. */
const PROP_CLASS: Record<number, { mwd: string; ab: string }> = {
  500_000_000: { mwd: "50000MN Microwarpdrive II", ab: "10000MN Afterburner II" },
  50_000_000: { mwd: "500MN Microwarpdrive II", ab: "100MN Afterburner II" },
  5_000_000: { mwd: "50MN Microwarpdrive II", ab: "10MN Afterburner II" },
  500_000: { mwd: "5MN Microwarpdrive II", ab: "1MN Afterburner II" },
};

const ROLLER_NAME = /\broll(er|ers|ing)?\b|hole control/i;

interface Prop { name: string; kind: "MWD" | "AB"; mass: number }

function propOf(sde: Sde, m: FittedModule): Prop | null {
  if (sde.type(m.type_id)?.group_id !== PROPULSION_GROUP) return null;
  const mass = sde.attr(m.type_id, MASS_ADDITION);
  if (!mass) return null;
  return { name: sde.typeName(m.type_id), kind: sde.attr(m.type_id, SIGNATURE_RADIUS_BONUS) != null ? "MWD" : "AB", mass };
}

/**
 * Jump mass and roller advice for wormhole rolling fits, or undefined when the fit doesn't look like a roller
 * (name/description mentions rolling, a Higgs Anchor is fitted, or it carries more than one prop module).
 * Prop modules add mass only while running, so a roller picks its jump mass by which one is on.
 */
export function rollingAnalysis(sde: Sde, fit: Fit) {
  const modules = Object.values(fit.slots).flat().filter((m): m is FittedModule => !!m && !m.offline);
  const props = modules.map((m) => propOf(sde, m)).filter((p): p is Prop => !!p);
  const higgs = fit.slots.rig.filter((m) => m && sde.attr(m.type_id, MASS_BONUS_PERCENTAGE));
  const named = ROLLER_NAME.test(`${fit.name} ${fit.description ?? ""}`);
  if (!named && !higgs.length && props.length < 2) return undefined;

  // Plates and other modules add mass while online; Higgs Anchors scale the total (applied after additions).
  const added = modules.filter((m) => !propOf(sde, m)).reduce((s, m) => s + (sde.attr(m.type_id, MASS_ADDITION) ?? 0), 0);
  const factor = higgs.reduce((f, m) => f * (1 + (sde.attr(m!.type_id, MASS_BONUS_PERCENTAGE) ?? 0) / 100), 1);
  const hull = sde.type(fit.ship_type_id)?.mass ?? sde.attr(fit.ship_type_id, ATTR.mass) ?? 0;
  const cold = (hull + added) * factor;
  const row = (mode: string, kg: number, module?: string) => ({ mode, ...(module ? { module } : {}), mass: massText(kg), mass_kg: round(kg, 0) });

  const unique = [...new Map(props.map((p) => [p.name, p])).values()].sort((a, b) => b.mass - a.mass || a.kind.localeCompare(b.kind));
  const jumpMass = [row("cold (no prop running)", cold), ...unique.map((p) => row(`hot (${p.kind})`, cold + p.mass * factor, p.name))];

  const advice: string[] = [];
  const top = unique[0]?.mass;
  const cls = top ? PROP_CLASS[top] : undefined;
  if (!unique.length) {
    advice.push("No prop module: fit the biggest microwarpdrive the hull can power. It adds the most mass and is the fastest way back to the hole.");
  } else {
    if (!unique.some((p) => p.kind === "MWD" && p.mass === top)) {
      advice.push(
        `No microwarpdrive of the biggest size fitted: add a ${cls?.mwd ?? "microwarpdrive of that size"}. ` +
          "It adds the same mass and is the fastest way back to the hole.",
      );
    }
    if (!unique.some((p) => p.kind === "AB" && p.mass === top)) {
      advice.push(
        `No afterburner to back up the MWD: a warp scrambler shuts microwarpdrives off, leaving you only the cold mass. ` +
          `A ${cls?.ab ?? "afterburner of the same size"} adds the same +${massText(top!)} and still runs while scrammed, so you can still jump hot and crush the hole.`,
      );
    }
    for (const p of unique.filter((x) => x.mass < top!)) {
      advice.push(
        `${p.name} adds only +${massText(p.mass * factor)} (${round((p.mass / top!) * 100, 1)}% of the big prop module): ` +
          "probably not worth the slot on a roller; tank or cap usually does more.",
      );
    }
  }

  return {
    note:
      "Wormhole jump mass from static data. Prop modules add mass only while running, so pick the jump mass by which one is on " +
      "(run one at a time). Includes plates/Higgs Anchors; check the ship's mass in game or Pyfa before relying on exact numbers.",
    hull_mass: massText(hull),
    ...(higgs.length ? { higgs_anchor: `mass x${round(factor, 2)}` } : {}),
    jump_mass: jumpMass,
    advice: advice.length ? advice : undefined,
  };
}
