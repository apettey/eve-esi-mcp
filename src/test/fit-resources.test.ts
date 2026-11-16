import assert from "node:assert/strict";
import { computeResources, fittingFixes } from "../fit/resources.js";
import { parseEft } from "../fit/model.js";
import type { CharacterSkills } from "../skills.js";
import { callTool, character, esiError, sde, testCtx, withSde } from "./harness.js";

/** The fit a user could not online on a 2m SP pilot: role bonus on the launchers, short on powergrid. */
export const NAGA_EFT = `[Naga Navy Issue, Othello-DPS-NN]
Ballistic Control System II
Ballistic Control System II
Power Diagnostic System II

Large F-S9 Regolith Compact Shield Extender
Large F-S9 Regolith Compact Shield Extender
Multispectrum Shield Hardener II
Missile Guidance Computer II
50MN Cold-Gas Enduring Microwarpdrive
Sensor Booster II
Sensor Booster II

'Arbalest' Cruise Launcher I
'Arbalest' Cruise Launcher I
'Arbalest' Cruise Launcher I
'Arbalest' Cruise Launcher I
'Arbalest' Cruise Launcher I
'Arbalest' Cruise Launcher I
Improved Cloaking Device II

Medium Core Defense Field Extender I
Medium Core Defense Field Extender I
Medium Hydraulic Bay Thrusters II
`;

/** The relevant part of that pilot's sheet. */
export const PRISONER_SKILLS: Record<string, number> = {
  "Power Grid Management": 3, "CPU Management": 4, "Shield Upgrades": 3, "Weapon Upgrades": 4,
  "Energy Grid Upgrades": 4, "Advanced Weapon Upgrades": 0, "Cybernetics": 4, "Electronics Upgrades": 0,
};

function skillSheet(levels: Record<string, number>, unallocated = 0): CharacterSkills {
  const map = new Map<number, { trained: number; active: number; sp: number }>();
  for (const [name, level] of Object.entries(levels)) {
    const id = sde!.typeIdByName(name)!;
    map.set(id, { trained: level, active: level, sp: 0 });
  }
  return { levels: map, total_sp: 2_000_000, unallocated_sp: unallocated, attributes: { 164: 17, 165: 21, 166: 17, 167: 27, 168: 17 } };
}

const near = (actual: number, expected: number, msg: string) => assert.ok(Math.abs(actual - expected) < 0.01, `${msg}: ${actual} vs ${expected}`);

withSde("ship role bonuses apply to base CPU/PG (Naga Navy Issue launchers need 5% of their grid)", () => {
  const { fit } = parseEft(sde!, NAGA_EFT);
  const r = computeResources(sde!, fit);
  // 6 x 72.5 launchers + 2 x 140 shield extenders + 150 MWD + 7 x 1 small modules.
  near(r.pg.used, 872, "powergrid used without skills");
  near(r.pg.output, 650 * 1.06, "powergrid output with the Power Diagnostic System II");
});

withSde("character skills apply through dogma: Shield Upgrades, Power Grid Management, Weapon Upgrades", () => {
  const { fit } = parseEft(sde!, NAGA_EFT);
  const r = computeResources(sde!, fit, { skills: skillSheet(PRISONER_SKILLS) });
  near(r.pg.used, 830, "shield extenders 15% cheaper at Shield Upgrades 3");
  near(r.pg.output, 650 * 1.15 * 1.06, "Power Grid Management 3 and PDS II");
  assert.ok(r.cpu.used < r.cpu.output, "CPU fits");
});

/** All-5 CPU/PG from Pyfa v2.69.3 (eve-fit evaluate_fit) for fits that exercise different dogma paths. */
const PYFA_ALL_5: Array<{ eft: string; cpu: number; pg: number; why: string }> = [
  {
    why: "per-level hull bonus (Covert Ops) on torpedo launcher grid, flat role bonus on cloak CPU, ACR rigs",
    eft: "[Purifier, p]\nBallistic Control System II\nMicro Auxiliary Power Core II\n\n5MN Y-T8 Compact Microwarpdrive\nWarp Disruptor II\n\n" +
      "Torpedo Launcher II\nTorpedo Launcher II\nTorpedo Launcher II\nCovert Ops Cloaking Device II\n\nSmall Ancillary Current Router I\nSmall Ancillary Current Router I\n",
    cpu: 357.5, pg: 33.14,
  },
  {
    why: "second-order modifier: the T3 subsystem sets the CPU a covert cloak adds on a non-covert Tengu",
    eft: "[Tengu, t]\nBallistic Control System II\nBallistic Control System II\nPower Diagnostic System II\nCo-Processor II\n\n" +
      "Large Shield Extender II\nLarge Shield Extender II\nMultispectrum Shield Hardener II\n50MN Microwarpdrive II\n\n" +
      "Heavy Assault Missile Launcher II\nHeavy Assault Missile Launcher II\nHeavy Assault Missile Launcher II\nHeavy Assault Missile Launcher II\n" +
      "Heavy Assault Missile Launcher II\nCovert Ops Cloaking Device II\n\nMedium Core Defense Field Extender II\nMedium Core Defense Field Extender II\n" +
      "Medium Core Defense Field Extender II\n\nTengu Core - Augmented Graviton Reactor\nTengu Defensive - Supplemental Screening\n" +
      "Tengu Offensive - Accelerated Ejection Bay\nTengu Propulsion - Interdiction Nullifier\n",
    cpu: 10521.1, pg: 791.4,
  },
  {
    why: "Co-Processor, PDS and a CPU rig with Weapon Upgrades/Energy Grid Upgrades on launchers and lows",
    eft: "[Drake, d]\nBallistic Control System II\nBallistic Control System II\nPower Diagnostic System II\nCo-Processor II\n\n" +
      "Large Shield Extender II\nLarge Shield Extender II\nMultispectrum Shield Hardener II\nEM Shield Hardener II\n10MN Afterburner II\n" +
      "Missile Guidance Computer II\n\nHeavy Missile Launcher II\nHeavy Missile Launcher II\nHeavy Missile Launcher II\nHeavy Missile Launcher II\n" +
      "Heavy Missile Launcher II\nHeavy Missile Launcher II\n\nMedium Core Defense Field Extender I\nMedium Core Defense Field Extender I\n" +
      "Medium Processor Overclocking Unit I\n",
    cpu: 582, pg: 868,
  },
];

withSde("CPU/PG match Pyfa for an all-5 pilot", () => {
  const all5 = new Map<number, { trained: number; active: number; sp: number }>();
  for (const r of sde!.db.prepare("SELECT t.id FROM types t JOIN groups g ON g.id = t.group_id WHERE g.category_id = 16 AND t.published = 1").all() as any[]) {
    all5.set(r.id, { trained: 5, active: 5, sp: 0 });
  }
  const skills: CharacterSkills = { levels: all5, total_sp: 0, unallocated_sp: 0, attributes: {} };
  for (const ref of PYFA_ALL_5) {
    const { fit, warnings } = parseEft(sde!, ref.eft);
    assert.deepEqual(warnings, [], ref.why);
    const r = computeResources(sde!, fit, { skills });
    assert.ok(Math.abs(r.cpu.used - ref.cpu) < 0.06, `${ref.why}: CPU ${r.cpu.used} vs Pyfa ${ref.cpu}`);
    assert.ok(Math.abs(r.pg.used - ref.pg) < 0.06, `${ref.why}: PG ${r.pg.used} vs Pyfa ${ref.pg}`);
  }
});

withSde("fitting fixes list skills, implants, modules, rigs and variants that close a powergrid gap", () => {
  const { fit } = parseEft(sde!, NAGA_EFT);
  const fixes = fittingFixes(sde!, fit, skillSheet(PRISONER_SKILLS, 83_587))!;
  assert.ok(fixes, "fixes are offered when the fit is over");
  assert.match(fixes.over.powergrid!.short_by, /^37\.65 MW$/);
  assert.equal(fixes.over.cpu, undefined, "CPU is not over");

  const pgm = fixes.skills.find((s) => s.skill === "Power Grid Management")!;
  assert.equal(pgm.trained_level, 3);
  near(pgm.next_level.gain_mw, 650 * 0.05 * 1.06, "PGM 4 adds 5% of base output, times the PDS");
  const su = fixes.skills.find((s) => s.skill === "Shield Upgrades")!;
  near(su.next_level.gain_mw, 14, "Shield Upgrades 4 saves 5% on two 140 MW extenders");
  assert.ok(fixes.skills.some((s) => s.skill === "Advanced Weapon Upgrades"), "AWU reduces launcher grid");
  assert.ok(!fixes.skills.some((s) => s.skill === "CPU Management"), "CPU skills don't help a grid shortfall");

  assert.ok(fixes.skill_plan.closes_gap, "a skill plan closes the gap");
  assert.match(fixes.skill_plan.unallocated_sp ?? "", /83,587/);

  const eg5 = fixes.implants.find((i) => /Power Grid Management EG-605/.test(i.implant))!;
  assert.equal(eg5.slot, 6);
  assert.equal(eg5.closes_gap, true, "EG-605 alone covers 37.65 MW");
  assert.ok(fixes.implants.some((i) => /Shield Upgrades SU-60/.test(i.implant)), "shield extender implants count too");

  assert.ok(fixes.modules.some((m) => /Reactor Control Unit/.test(m.module) && m.closes_gap), "RCU swap closes it");
  const acr = fixes.modules.find((m) => /Medium Ancillary Current Router/.test(m.module))!;
  assert.ok(acr, "powergrid rig offered");
  assert.equal(acr.slot, "rig");
  assert.ok(!fixes.modules.some((m) => /Capacitor Power Relay/.test(m.module)), "only modules that add output, not ones that just free a slot");
  assert.ok(!fixes.implants.some((i) => /Augmentation Chip/.test(i.implant)), "new-character-only boosters are left out");

  assert.ok(fixes.cheaper_variants.some((v) => /Shield Extender/.test(v.replace)), "lower-grid shield extender variants");
});

withSde("no fixes when the fit already fits", () => {
  const { fit } = parseEft(sde!, NAGA_EFT);
  const all5 = Object.fromEntries(Object.keys(PRISONER_SKILLS).map((k) => [k, 5]));
  assert.equal(fittingFixes(sde!, fit, skillSheet(all5)), undefined);
});

withSde("fitting_analyze reports dogma-based resources and fixes for the character", async () => {
  const pilot = character(90000311, "Grid Pilot");
  const sheet = skillSheet(PRISONER_SKILLS, 83_587);
  const ctx = testCtx({
    characters: [pilot],
    esi: {
      [`/characters/${pilot.id}/skills`]: {
        skills: [...sheet.levels].map(([id, l]) => ({ skill_id: id, trained_skill_level: l.trained, active_skill_level: l.active, skillpoints_in_skill: 0 })),
        total_sp: 2_000_000, unallocated_sp: 83_587,
      },
      [`/characters/${pilot.id}/attributes`]: { charisma: 17, intelligence: 21, memory: 17, perception: 27, willpower: 17 },
    },
  });
  const r = await callTool(ctx, "fitting_analyze", { eft: NAGA_EFT, attributes: "none" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.resources.powergrid.used, "872 MW", "no 9137 MW from ignoring the role bonus");
  assert.equal(r.json.resources.with_character_skills.powergrid.used, "830 MW");
  assert.equal(r.json.fitting_fixes.character, "Grid Pilot");
  assert.match(r.json.fitting_fixes.over.powergrid.short_by, /MW$/);
  assert.ok(r.json.fitting_fixes.implants.length > 0);
});

withSde("fitting_analyze says why a character's skills are missing instead of asking for a character", async () => {
  const pilot = character(90000312, "Gateway Pilot");
  const ctx = testCtx({
    characters: [pilot],
    esi: {
      [`/characters/${pilot.id}/skills`]: () => { throw esiError(502, "Bad Gateway", `/characters/${pilot.id}/skills`); },
      [`/characters/${pilot.id}/attributes`]: { charisma: 17, intelligence: 21, memory: 17, perception: 27, willpower: 17 },
    },
  });
  const r = await callTool(ctx, "fitting_analyze", { eft: NAGA_EFT, attributes: "none" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.json.skill_check.note, /Could not load Gateway Pilot's skills .*502/);
  assert.equal(r.json.fitting_fixes, undefined);
  assert.equal(r.json.resources.powergrid.used, "872 MW", "base resources still there");
});
