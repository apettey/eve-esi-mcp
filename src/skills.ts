import type { StoredCharacter } from "./auth/store.js";
import type { Esi } from "./esi/client.js";
import { ATTR, type Sde } from "./sde/db.js";
import { duration } from "./util.js";

export interface CharacterSkills {
  levels: Map<number, { trained: number; active: number; sp: number }>;
  total_sp: number;
  unallocated_sp: number;
  attributes: Record<number, number>;
}

const ATTRIBUTE_NAMES: Record<number, string> = {
  [ATTR.charisma]: "charisma",
  [ATTR.intelligence]: "intelligence",
  [ATTR.memory]: "memory",
  [ATTR.perception]: "perception",
  [ATTR.willpower]: "willpower",
};

export function attributeName(id: number | null | undefined): string | null {
  return id != null ? ATTRIBUTE_NAMES[id] ?? null : null;
}

export async function loadSkills(esi: Esi, character: StoredCharacter): Promise<CharacterSkills> {
  const [skills, attrs] = await Promise.all([
    esi.get<any>(`/characters/${character.id}/skills`, { character, scope: "esi-skills.read_skills.v1" }),
    esi.get<any>(`/characters/${character.id}/attributes`, { character, scope: "esi-skills.read_skills.v1" }),
  ]);
  return {
    levels: new Map(
      skills.skills.map((s: any) => [s.skill_id, { trained: s.trained_skill_level, active: s.active_skill_level, sp: s.skillpoints_in_skill }]),
    ),
    total_sp: skills.total_sp,
    unallocated_sp: skills.unallocated_sp ?? 0,
    attributes: {
      [ATTR.charisma]: attrs.charisma,
      [ATTR.intelligence]: attrs.intelligence,
      [ATTR.memory]: attrs.memory,
      [ATTR.perception]: attrs.perception,
      [ATTR.willpower]: attrs.willpower,
    },
  };
}

/** Total skill points needed to reach `level` for a skill of the given rank. */
export function spForLevel(rank: number, level: number): number {
  if (level <= 0) return 0;
  return Math.ceil(250 * rank * Math.pow(2, 2.5 * (level - 1)));
}

/** Skill points per minute for a skill, given character attributes (defaults to a neutral 20/20). */
export function spPerMinute(sde: Sde, skillId: number, attributes?: Record<number, number>): number {
  const primary = sde.attr(skillId, ATTR.primaryAttribute);
  const secondary = sde.attr(skillId, ATTR.secondaryAttribute);
  const p = (primary && attributes?.[primary]) || 20;
  const s = (secondary && attributes?.[secondary]) || 20;
  return p + s / 2;
}

/** Below this fraction of the omega rate, a queue is training at alpha speed (alphas train at 50%). */
const ALPHA_RATE_THRESHOLD = 0.8;

export interface CloneState {
  possibly_alpha?: boolean;
  evidence?: string;
}

/**
 * Infers alpha/omega, which ESI doesn't report directly. Two signals:
 * - Training rate: alphas train at half the omega rate (primary + secondary / 2). Implants and boosters only speed
 *   training up, so a dated queue entry well below the omega rate means an alpha clone; at or above it, an omega.
 * - Capped skills: an alpha's active level is below the trained level for skills beyond the alpha limits.
 * Returns no verdict when the queue is paused or empty and no skill is capped.
 */
export function cloneState(sde: Sde, skills: CharacterSkills, queue?: any[] | null): CloneState {
  const capped = [...skills.levels.values()].some((s) => s.active < s.trained);
  const dated = [...(queue ?? [])]
    .sort((a, b) => a.queue_position - b.queue_position)
    .find((q) => q.start_date && q.finish_date && q.level_end_sp > (q.training_start_sp ?? q.level_start_sp ?? 0));
  if (dated) {
    const minutes = (Date.parse(dated.finish_date) - Date.parse(dated.start_date)) / 60_000;
    const sp = dated.level_end_sp - (dated.training_start_sp ?? dated.level_start_sp ?? 0);
    if (minutes > 0) {
      const ratio = sp / minutes / spPerMinute(sde, dated.skill_id, skills.attributes);
      const pct = `${Math.round(ratio * 100)}% of omega speed`;
      if (ratio < ALPHA_RATE_THRESHOLD) return { possibly_alpha: true, evidence: `alpha: queue trains at ${pct}` };
      return capped
        ? { possibly_alpha: true, evidence: `queue trains at ${pct}, but some skills are capped below their trained level` }
        : { possibly_alpha: false, evidence: `omega: queue trains at ${pct}` };
    }
  }
  if (capped) return { possibly_alpha: true, evidence: "alpha: some skills are capped below their trained level" };
  return {};
}

/**
 * Collapses the required skills of the given types, including all prerequisite skills recursively,
 * into skillId -> highest required level.
 */
export function requirementClosure(sde: Sde, typeIds: Iterable<number>): Map<number, number> {
  const req = new Map<number, number>();
  const visit = (skillId: number, level: number, depth: number) => {
    if ((req.get(skillId) ?? 0) >= level && depth > 0) return;
    req.set(skillId, Math.max(req.get(skillId) ?? 0, level));
    if (depth > 12) return;
    for (const r of sde.requiredSkills(skillId)) visit(r.skill_id, r.level, depth + 1);
  };
  for (const t of typeIds) for (const r of sde.requiredSkills(t)) visit(r.skill_id, r.level, 1);
  return req;
}

export interface SkillGap {
  skill: string;
  skill_id: number;
  required_level: number;
  trained_level: number;
  sp_needed: number;
  training_time: string;
}

/** Compares requirements with a character's skills; returns missing levels and estimated training time. */
export function skillGaps(sde: Sde, required: Map<number, number>, skills?: CharacterSkills) {
  const gaps: SkillGap[] = [];
  let totalSp = 0;
  let totalMinutes = 0;
  for (const [skillId, level] of required) {
    const have = skills?.levels.get(skillId);
    const trained = have?.trained ?? 0;
    if (trained >= level) continue;
    const rank = sde.attr(skillId, ATTR.skillRank) ?? 1;
    const sp = spForLevel(rank, level) - Math.max(have?.sp ?? 0, spForLevel(rank, trained));
    const minutes = sp / spPerMinute(sde, skillId, skills?.attributes);
    totalSp += sp;
    totalMinutes += minutes;
    gaps.push({
      skill: sde.typeName(skillId),
      skill_id: skillId,
      required_level: level,
      trained_level: trained,
      sp_needed: sp,
      training_time: duration(minutes * 60_000),
    });
  }
  gaps.sort((a, b) => a.skill.localeCompare(b.skill));
  return {
    can_use: gaps.length === 0,
    missing: gaps,
    total_sp_needed: totalSp,
    total_training_time: duration(totalMinutes * 60_000),
  };
}

/** Direct requirements of one type, annotated with the character's levels when available. */
export function describeRequirements(sde: Sde, typeId: number, skills?: CharacterSkills) {
  return sde.requiredSkills(typeId).map((r) => {
    const trained = skills?.levels.get(r.skill_id)?.trained;
    return {
      skill: sde.typeName(r.skill_id),
      level: r.level,
      ...(skills ? { trained_level: trained ?? 0, met: (trained ?? 0) >= r.level } : {}),
    };
  });
}
