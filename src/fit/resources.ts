import { ATTR, CATEGORY, type DogmaModifier, type Sde } from "../sde/db.js";
import { requirementClosure, skillGaps, type CharacterSkills } from "../skills.js";
import { round } from "../util.js";
import { shipSlotCounts, type Fit, type SlotKind } from "./model.js";

/**
 * Fitting resources (CPU, powergrid, calibration) calculated from the game's dogma rules in the SDE: ship hull and
 * role bonuses, online modules, rigs, implants and the character's skills. All four attributes involved are
 * stackable, so no stacking penalties apply. Engine stats (eve-fit) remain the reference for everything else.
 */

const SKILL_LEVEL = 280;
const MAX_GROUP_FITTED = 1544;
const BOOSTER_MAX_CHAR_AGE_HOURS = 1647;
const OUTPUT_ATTRS = [ATTR.cpuOutput, ATTR.powerOutput];
const NEED_ATTRS = [ATTR.cpu, ATTR.power];
const FITTING_ATTRS = new Set<number>([...OUTPUT_ATTRS, ...NEED_ATTRS]);
const PASSIVE = 0;
const ONLINE = 4;

export interface ResourceOptions {
  /** The character's skills; absent = every skill at 0. */
  skills?: CharacterSkills;
  /** Skill levels that replace the character's (what-if training). */
  levels?: Map<number, number>;
  /** Extra implants (they replace a fitted implant in the same slot). */
  implants?: number[];
}

export interface Resources {
  cpu: { used: number; output: number };
  pg: { used: number; output: number };
  calibration: { used: number; output: number };
}

type ResKey = "cpu" | "pg";
const RES: Record<ResKey, { need: number; output: number; unit: string; gainKey: "gain_tf" | "gain_mw"; label: string }> = {
  cpu: { need: ATTR.cpu, output: ATTR.cpuOutput, unit: "tf", gainKey: "gain_tf", label: "cpu" },
  pg: { need: ATTR.power, output: ATTR.powerOutput, unit: "MW", gainKey: "gain_mw", label: "powergrid" },
};

interface Source {
  type_id: number;
  kind: "ship" | "module" | "implant" | "skill";
  /** Index into the module list when kind is module. */
  module?: number;
  level?: number;
}

function levelOf(opts: ResourceOptions, skillId: number): number {
  return opts.levels?.get(skillId) ?? opts.skills?.levels.get(skillId)?.active ?? 0;
}

const requiredSkillCache = new WeakMap<Sde, Map<number, Set<number>>>();
function requiresSkill(sde: Sde, typeId: number, skillId: number): boolean {
  let cache = requiredSkillCache.get(sde);
  if (!cache) requiredSkillCache.set(sde, (cache = new Map()));
  let set = cache.get(typeId);
  if (!set) cache.set(typeId, (set = new Set(sde.requiredSkills(typeId).map((r) => r.skill_id))));
  return set.has(skillId);
}

/**
 * Ship bonuses "per level" are not scaled in dogma data: find the hull skill whose listed bonus matches the value.
 * Role bonuses (and anything not listed per skill) apply flat.
 */
function shipBonusLevel(sde: Sde, shipId: number, mod: DogmaModifier, value: number, opts: ResourceOptions): number {
  if (/role/i.test(mod.effect_name ?? "")) return 1;
  for (const s of sde.typeBonus(shipId)?.skills ?? []) {
    if ((s.bonuses ?? []).some((b: any) => b.bonus != null && Math.abs(Math.abs(b.bonus) - Math.abs(value)) < 1e-6)) {
      return levelOf(opts, s.skill_id);
    }
  }
  return 1;
}

function apply(base: number, mods: Array<{ op: number; value: number }>): number {
  let v = base;
  const by = (op: number) => mods.filter((m) => m.op === op).map((m) => m.value);
  for (const x of by(-1)) v = x;
  for (const x of by(0)) v *= x;
  for (const x of by(1)) v = x ? v / x : v;
  for (const x of by(2)) v += x;
  for (const x of by(3)) v -= x;
  for (const x of by(4)) v *= x;
  for (const x of by(5)) v = x ? v / x : v;
  for (const x of by(6)) v *= 1 + x / 100;
  for (const x of by(7)) v = x;
  return v;
}

/** Skills that change any fitting resource; computed once per SDE. */
const fittingSkillCache = new WeakMap<Sde, number[]>();
function fittingSkills(sde: Sde): number[] {
  let ids = fittingSkillCache.get(sde);
  if (!ids) fittingSkillCache.set(sde, (ids = sde.typesModifying(CATEGORY.skill, [...FITTING_ATTRS])));
  return ids;
}

function implantSlot(sde: Sde, typeId: number): number | null {
  return sde.attr(typeId, ATTR.implantSlot) ?? null;
}

export function computeResources(sde: Sde, fit: Fit, opts: ResourceOptions = {}): Resources {
  const modules: number[] = [];
  for (const kind of ["high", "med", "low", "rig", "subsystem", "service"] as SlotKind[]) {
    for (const m of fit.slots[kind]) if (m && !m.offline) modules.push(m.type_id);
  }
  let implants = [...fit.implants];
  for (const extra of opts.implants ?? []) {
    const slot = implantSlot(sde, extra);
    implants = implants.filter((i) => slot == null || implantSlot(sde, i) !== slot);
    implants.push(extra);
  }

  // Items: 0 = ship, then modules, implants and skills. Every modifier is indexed by the item and attribute it changes,
  // and attribute values are evaluated lazily, so a modifier's own value can itself be modified (e.g. a skill's
  // bonus scaled by its level, or a T3 subsystem raising the CPU a covert cloak adds).
  const items: Source[] = [{ type_id: fit.ship_type_id, kind: "ship" }];
  const moduleIdx: number[] = [];
  modules.forEach((t, i) => { moduleIdx.push(items.length); items.push({ type_id: t, kind: "module", module: i }); });
  for (const t of implants) items.push({ type_id: t, kind: "implant" });
  for (const s of fittingSkills(sde)) {
    const level = levelOf(opts, s);
    if (level > 0) items.push({ type_id: s, kind: "skill", level });
  }

  const targets = new Map<string, Array<{ src: number; mod: DogmaModifier }>>();
  const push = (item: number, src: number, mod: DogmaModifier) => {
    const key = `${item}:${mod.modified_attr}`;
    if (!targets.has(key)) targets.set(key, []);
    targets.get(key)!.push({ src, mod });
  };
  items.forEach((src, s) => {
    for (const mod of sde.typeModifiers(src.type_id)) {
      if (mod.modifying_attr == null) continue;
      if (mod.effect_category !== PASSIVE && mod.effect_category !== ONLINE) continue;
      if (mod.func === "ItemModifier" && mod.domain === "shipID") push(0, s, mod);
      else if (mod.func === "ItemModifier" && mod.domain === "itemID") push(s, s, mod);
      else if (mod.domain === "shipID" && (mod.func === "LocationGroupModifier" || mod.func === "LocationRequiredSkillModifier" || mod.func === "LocationModifier")) {
        modules.forEach((t, i) => {
          const hit = mod.func === "LocationModifier" ||
            (mod.func === "LocationGroupModifier" ? sde.type(t)?.group_id === mod.group_id : requiresSkill(sde, t, mod.skill_id!));
          if (hit) push(moduleIdx[i], s, mod);
        });
      }
    }
  });

  const memo = new Map<string, number>();
  const value = (item: number, attr: number, depth = 0): number => {
    const key = `${item}:${attr}`;
    const known = memo.get(key);
    if (known != null) return known;
    const it = items[item];
    let base = it.kind === "skill" && attr === SKILL_LEVEL
      ? it.level ?? 0
      : sde.attr(it.type_id, attr) ?? sde.attributeDefs().get(attr)?.default_value ?? 0;
    if (depth < 8) {
      const mods = (targets.get(key) ?? []).map(({ src, mod }) => {
        let v = value(src, mod.modifying_attr!, depth + 1);
        if (items[src].kind === "ship") v *= shipBonusLevel(sde, items[src].type_id, mod, v, opts);
        return { op: mod.operation, value: v };
      });
      base = apply(base, mods);
    }
    memo.set(key, base);
    return base;
  };

  const shipAttr = (a: number) => value(0, a);
  const need = (a: number) => moduleIdx.reduce((sum, idx) => sum + value(idx, a), 0);
  let calibration = 0;
  for (const m of fit.slots.rig) if (m) calibration += sde.attr(m.type_id, ATTR.upgradeCost) ?? 0;
  return {
    cpu: { used: round(need(ATTR.cpu), 2), output: round(shipAttr(ATTR.cpuOutput), 2) },
    pg: { used: round(need(ATTR.power), 2), output: round(shipAttr(ATTR.powerOutput), 2) },
    calibration: { used: calibration, output: sde.attr(fit.ship_type_id, ATTR.calibration) ?? 0 },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// What to change when a fit does not fit

const fmt = (n: number, unit: string) => `${round(n, 2).toLocaleString("en-US")} ${unit}`;
const free = (r: Resources, k: ResKey) => r[k].output - r[k].used;
const fits = (r: Resources) => r.cpu.used <= r.cpu.output + 1e-6 && r.pg.used <= r.pg.output + 1e-6 && r.calibration.used <= r.calibration.output;

function gains(base: Resources, next: Resources, over: ResKey[]) {
  const out: Record<string, number> = {};
  for (const k of over) out[RES[k].gainKey] = round(free(next, k) - free(base, k), 2);
  return out;
}
/** Progress towards fitting, comparable across CPU and powergrid: share of each shortfall closed. */
function progress(base: Resources, next: Resources, over: ResKey[]) {
  return over.reduce((s, k) => s + Math.min(1, (free(next, k) - free(base, k)) / Math.max(1e-6, base[k].used - base[k].output)), 0);
}
const helps = (g: Record<string, number>) => Object.values(g).some((v) => v > 0.005) && Object.values(g).every((v) => v > -0.005);

function withModule(fit: Fit, kind: SlotKind, index: number, typeId: number): Fit {
  const slots = { ...fit.slots, [kind]: [...fit.slots[kind]] };
  slots[kind][index] = { type_id: typeId };
  return { ...fit, slots };
}

function slotLabel(sde: Sde, fit: Fit, kind: SlotKind, index: number) {
  const m = fit.slots[kind][index];
  return m ? `${sde.typeName(m.type_id)} (${kind}:${index})` : `empty ${kind}:${index}`;
}

function usability(sde: Sde, typeId: number, skills: CharacterSkills) {
  const gaps = skillGaps(sde, requirementClosure(sde, [typeId]), skills);
  return gaps.can_use
    ? { usable: true }
    : { usable: false, needs: gaps.missing.map((m) => `${m.skill} ${m.required_level}`).join(", "), training_time: gaps.total_training_time };
}

const SLOT_KINDS: SlotKind[] = ["high", "med", "low", "rig"];

/**
 * When a fit is over CPU or powergrid for a character: every lever that helps, each calculated with dogma —
 * skill levels (with training time), a skill plan that closes the gap, implants, fitting modules and rigs
 * (and what they would replace), and lower-need variants of the fitted modules. Undefined when the fit fits.
 */
export function fittingFixes(sde: Sde, fit: Fit, skills: CharacterSkills, opts: { limit?: number } = {}) {
  const limit = opts.limit ?? 8;
  const base = computeResources(sde, fit, { skills });
  const over = (["cpu", "pg"] as ResKey[]).filter((k) => base[k].used > base[k].output + 1e-6);
  if (!over.length) return undefined;
  const short = Object.fromEntries(over.map((k) => [RES[k].label, {
    used: fmt(base[k].used, RES[k].unit),
    available: fmt(base[k].output, RES[k].unit),
    short_by: fmt(base[k].used - base[k].output, RES[k].unit),
  }]));
  const relevant = [...over.map((k) => RES[k].need), ...over.map((k) => RES[k].output)];
  const evalWith = (o: Partial<ResourceOptions>, f: Fit = fit) => computeResources(sde, f, { skills, ...o });

  // Skills: next level and level 5, each on its own, with training time including prerequisites.
  const trainTo = (skillId: number, level: number) => {
    const req = requirementClosure(sde, [skillId]);
    req.set(skillId, level);
    return skillGaps(sde, req, skills);
  };
  const candidates = sde.typesModifying(CATEGORY.skill, relevant);
  const skillRows = [];
  for (const id of candidates) {
    const now = levelOf({ skills }, id);
    if (now >= 5) continue;
    const next = evalWith({ levels: new Map([[id, now + 1]]) });
    const top = evalWith({ levels: new Map([[id, 5]]) });
    const gNext = gains(base, next, over);
    if (!helps(gNext) && !helps(gains(base, top, over))) continue;
    const tNext = trainTo(id, now + 1);
    const tTop = trainTo(id, 5);
    const prereqs = tNext.missing.filter((m) => m.skill_id !== id).map((m) => `${m.skill} ${m.required_level}`);
    skillRows.push({
      skill: sde.typeName(id),
      trained_level: now,
      next_level: { level: now + 1, ...gNext, training_time: tNext.total_training_time, sp: tNext.total_sp_needed },
      ...(now + 1 < 5 ? { level_5: { ...gains(base, top, over), training_time: tTop.total_training_time, sp: tTop.total_sp_needed } } : {}),
      closes_gap: fits(next),
      ...(prereqs.length ? { prerequisites: prereqs.join(", ") } : {}),
      _rank: progress(base, next, over),
    });
  }
  skillRows.sort((a, b) => b._rank - a._rank);

  // Greedy skill plan: the level with the most progress per minute of training, until the fit fits.
  const plan = new Map<number, number>();
  let planRes = base;
  const steps: string[] = [];
  for (let i = 0; i < 15 && !fits(planRes); i++) {
    let best: { id: number; level: number; res: Resources; score: number } | undefined;
    for (const id of candidates) {
      const level = (plan.get(id) ?? levelOf({ skills }, id)) + 1;
      if (level > 5) continue;
      const levels = new Map(plan).set(id, level);
      const res = evalWith({ levels });
      const gained = progress(planRes, res, over);
      if (gained <= 1e-6) continue;
      const req = requirementClosure(sde, [id]);
      req.set(id, level);
      for (const [pid, pl] of plan) req.set(pid, Math.max(req.get(pid) ?? 0, pl));
      const cost = skillGaps(sde, req, skills).total_sp_needed - skillGaps(sde, new Map(plan), skills).total_sp_needed;
      const score = gained / Math.max(1, cost);
      if (!best || score > best.score) best = { id, level, res, score };
    }
    if (!best) break;
    plan.set(best.id, best.level);
    planRes = best.res;
    steps.push(`${sde.typeName(best.id)} ${best.level}`);
  }
  const planReq = new Map<number, number>();
  for (const [id, level] of plan) {
    for (const [pid, pl] of requirementClosure(sde, [id])) planReq.set(pid, Math.max(planReq.get(pid) ?? 0, pl));
    planReq.set(id, level);
  }
  const planCost = skillGaps(sde, planReq, skills);
  const skillPlan = {
    train: steps,
    ...(planCost.missing.some((m) => !plan.has(m.skill_id)) ? {
      prerequisites: planCost.missing.filter((m) => !plan.has(m.skill_id)).map((m) => `${m.skill} ${m.required_level}`).join(", "),
    } : {}),
    closes_gap: fits(planRes),
    sp: planCost.total_sp_needed,
    training_time: planCost.total_training_time,
    ...(skills.unallocated_sp > 0 ? {
      unallocated_sp: `${skills.unallocated_sp.toLocaleString("en-US")} unallocated SP can be applied to these skills right now`,
    } : {}),
  };

  // Implants (and boosters) that change the over resource, alone in their slot.
  const implantRows = [];
  for (const id of sde.typesModifying(CATEGORY.implant, relevant)) {
    // New-character-only boosters (e.g. capsuleer augmentation chips) don't help an established pilot.
    if (sde.attr(id, BOOSTER_MAX_CHAR_AGE_HOURS) != null) continue;
    const res = evalWith({ implants: [id] });
    const g = gains(base, res, over);
    if (!helps(g)) continue;
    const t = sde.type(id);
    implantRows.push({
      implant: sde.typeName(id),
      ...(implantSlot(sde, id) != null ? { slot: implantSlot(sde, id)! } : { kind: "booster" }),
      ...g,
      closes_gap: fits(res),
      ...usability(sde, id, skills),
      _rank: progress(base, res, over),
      _meta: t?.meta_level ?? 0,
    });
  }
  implantRows.sort((a, b) => b._rank - a._rank || a._meta - b._meta);

  // Fitting modules and rigs: added to an empty slot or replacing a fitted module.
  const counts = shipSlotCounts(sde, fit.ship_type_id, fit);
  const shipRigSize = sde.attr(fit.ship_type_id, ATTR.rigSize);
  const moduleRows: Array<Record<string, unknown> & { _rank: number; _group: number; _meta: number; closes_gap: boolean }> = [];
  for (const id of sde.typesModifying(CATEGORY.module, over.map((k) => RES[k].output))) {
    const t = sde.type(id);
    const kind = t?.slot as SlotKind | undefined;
    if (!t || !kind || !SLOT_KINDS.includes(kind) || !counts[kind]) continue;
    if (kind === "rig" && sde.attr(id, ATTR.rigSize) !== shipRigSize) continue;
    const maxGroup = sde.attr(id, MAX_GROUP_FITTED);
    const tried = new Set<string>();
    let best: { res: Resources; index: number } | undefined;
    const closing: number[] = [];
    for (let i = 0; i < counts[kind]; i++) {
      const cur = fit.slots[kind][i];
      const key = cur ? `t${cur.type_id}` : "empty";
      if (tried.has(key) || cur?.type_id === id) continue;
      tried.add(key);
      const next = withModule(fit, kind, i, id);
      if (maxGroup) {
        const same = SLOT_KINDS.flatMap((k) => next.slots[k]).filter((m) => m && sde.type(m.type_id)?.group_id === t.group_id).length;
        if (same > maxGroup) continue;
      }
      const res = evalWith({}, next);
      // It has to add output itself, not just free what the replaced module used.
      if (!helps(gains(base, res, over)) || !over.some((k) => res[k].output > base[k].output + 1e-6)) continue;
      if (fits(res)) closing.push(i);
      if (!best || progress(base, res, over) > progress(base, best.res, over)) best = { res, index: i };
    }
    if (!best) continue;
    const shown = closing.length ? closing : [best.index];
    moduleRows.push({
      module: t.name,
      slot: kind,
      meta_group: t.meta_group ?? undefined,
      ...gains(base, best.res, over),
      [closing.length ? "replace_any_of" : "best_replacing"]: shown.map((i) => slotLabel(sde, fit, kind, i)),
      ...(kind === "rig" ? { calibration: sde.attr(id, ATTR.upgradeCost) ?? 0 } : {}),
      closes_gap: closing.length > 0,
      ...usability(sde, id, skills),
      _rank: progress(base, best.res, over),
      _group: t.group_id,
      _meta: t.meta_level ?? 0,
    });
  }
  // Per module group: the lowest meta level that closes the gap, and the biggest gain.
  const moduleKeep: typeof moduleRows = [];
  for (const g of new Set(moduleRows.map((r) => r._group))) {
    const rows = moduleRows.filter((r) => r._group === g && r.usable !== false);
    const pool = rows.length ? rows : moduleRows.filter((r) => r._group === g);
    const cheapest = pool.filter((r) => r.closes_gap).sort((a, b) => a._meta - b._meta)[0];
    const strongest = [...pool].sort((a, b) => b._rank - a._rank || a._meta - b._meta)[0];
    for (const r of new Set([cheapest, strongest].filter(Boolean))) moduleKeep.push(r!);
  }
  moduleKeep.sort((a, b) => Number(b.closes_gap) - Number(a.closes_gap) || b._rank - a._rank);

  // Lower-need variants of what is fitted (all copies swapped).
  const variantRows = [];
  const fitted = new Map<number, Array<{ kind: SlotKind; index: number }>>();
  for (const kind of SLOT_KINDS) {
    fit.slots[kind].forEach((m, index) => {
      if (!m || m.offline) return;
      if (!fitted.has(m.type_id)) fitted.set(m.type_id, []);
      fitted.get(m.type_id)!.push({ kind, index });
    });
  }
  for (const [typeId, places] of fitted) {
    if (!over.some((k) => (sde.attr(typeId, RES[k].need) ?? 0) > 0)) continue;
    const rows = [];
    for (const v of sde.variations(typeId)) {
      if (v === typeId) continue;
      let next = fit;
      for (const p of places) next = withModule(next, p.kind, p.index, v);
      const res = evalWith({}, next);
      const g = gains(base, res, over);
      if (!helps(g)) continue;
      const other = (["cpu", "pg"] as ResKey[]).filter((k) => !over.includes(k));
      rows.push({
        replace: `${sde.typeName(typeId)}${places.length > 1 ? ` x${places.length}` : ""}`,
        with: sde.typeName(v),
        meta_group: sde.type(v)?.meta_group ?? undefined,
        ...g,
        ...Object.fromEntries(other.map((k) => {
          const more = round(res[k].used - base[k].used, 2);
          return [`${RES[k].label}_used_change`, `${more > 0 ? "+" : ""}${fmt(more, RES[k].unit)}`];
        })),
        closes_gap: fits(res),
        ...usability(sde, v, skills),
        _rank: progress(base, res, over),
      });
    }
    rows.sort((a, b) => b._rank - a._rank);
    variantRows.push(...rows.slice(0, 2));
  }
  variantRows.sort((a, b) => b._rank - a._rank);

  const strip = <T extends Record<string, unknown>>(rows: T[]) =>
    rows.slice(0, limit).map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith("_"))));
  return {
    over: short as Record<"cpu" | "powergrid", { used: string; available: string; short_by: string } | undefined>,
    note:
      "Every option is calculated from the game's dogma rules (SDE) with this character's skills, on its own. Gains roughly add up " +
      "across different kinds of change; implants share slots with each other. Modules and variants trade other stats (damage, tank, " +
      "speed): decide with the user. Implants in the character's head are not included unless they are in the fit.",
    skills: strip(skillRows) as unknown as Array<{
      skill: string; trained_level: number; closes_gap: boolean;
      next_level: { level: number; gain_mw: number; gain_tf: number; training_time: string; sp: number };
    }>,
    skill_plan: skillPlan,
    implants: strip(implantRows) as unknown as Array<{ implant: string; slot?: number; closes_gap: boolean; gain_mw: number }>,
    modules: strip(moduleKeep) as unknown as Array<{ module: string; slot: string; closes_gap: boolean }>,
    cheaper_variants: strip(variantRows) as unknown as Array<{ replace: string; with: string; closes_gap: boolean }>,
  };
}
