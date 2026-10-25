import { test } from "node:test";
import assert from "node:assert/strict";
import { ATTR, type Sde } from "../sde/db.js";
import { cloneState, type CharacterSkills } from "../skills.js";

// Energy Grid Upgrades: Intelligence / Memory.
const EGU = 3424;
const fakeSde = {
  attr: (id: number, a: number) =>
    id === EGU ? ({ [ATTR.primaryAttribute]: ATTR.intelligence, [ATTR.secondaryAttribute]: ATTR.memory } as Record<number, number>)[a] ?? null : null,
} as unknown as Sde;

function skills(levels: [number, number, number][] = []): CharacterSkills {
  return {
    levels: new Map(levels.map(([id, trained, active]) => [id, { trained, active, sp: 0 }])),
    total_sp: 0,
    unallocated_sp: 0,
    attributes: { [ATTR.intelligence]: 20, [ATTR.memory]: 20, [ATTR.perception]: 20, [ATTR.willpower]: 20, [ATTR.charisma]: 19 },
  };
}

// EGU II -> III is 13,171 SP; at 20/20 an omega trains it in 7h 19m (30 SP/min).
const entry = (hours: number, extra: object = {}) => ({
  skill_id: EGU, finished_level: 3, queue_position: 0, level_start_sp: 2829, level_end_sp: 16000,
  start_date: "2026-10-26T12:00:00Z", finish_date: new Date(Date.parse("2026-10-26T12:00:00Z") + hours * 3600_000).toISOString(),
  ...extra,
});

test("cloneState: half omega speed means alpha", () => {
  // Real queue entry from a live alpha alt: EGU III took 14h 38m.
  const r = cloneState(fakeSde, skills(), [entry(14 + 38 / 60)]);
  assert.equal(r.possibly_alpha, true);
  assert.match(r.evidence!, /alpha: queue trains at 50% of omega speed/);
});

test("cloneState: omega speed (or faster, with implants) means omega", () => {
  assert.deepEqual(cloneState(fakeSde, skills(), [entry(13171 / 30 / 60)]), { possibly_alpha: false, evidence: "omega: queue trains at 100% of omega speed" });
  assert.equal(cloneState(fakeSde, skills(), [entry(5)]).possibly_alpha, false);
});

test("cloneState: uses training_start_sp for a level already partly trained", () => {
  // Half the level remains and it finishes in half the alpha time: still alpha.
  const r = cloneState(fakeSde, skills(), [entry((14 + 38 / 60) / 2, { training_start_sp: 2829 + 13171 / 2 })]);
  assert.equal(r.possibly_alpha, true);
});

test("cloneState: paused queue falls back to capped skills", () => {
  const paused = [{ skill_id: EGU, finished_level: 3, queue_position: 0, level_start_sp: 2829, level_end_sp: 16000 }];
  assert.deepEqual(cloneState(fakeSde, skills([[EGU, 2, 2]]), paused), {});
  assert.deepEqual(cloneState(fakeSde, skills([[EGU, 5, 4]]), paused), { possibly_alpha: true, evidence: "alpha: some skills are capped below their trained level" });
  assert.deepEqual(cloneState(fakeSde, skills(), null), {});
});
