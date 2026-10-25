import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTRACT, FitStats, eveFitLaunch, formatStats, type FitEngine } from "../fit/evefit.js";
import type { CharacterSkills } from "../skills.js";

// eve-fit itself is not needed: a fake engine records calls and answers per contract eve-fit/evaluate_fit@1.
const STATS = {
  dps_total: 55.123, dps_weapon: 55.123, dps_drone: 0, volley: 83.2,
  weapon_optimal: 750, weapon_falloff: 9675, weapon_tracking: 393.75,
  ehp_total: 2955.4, ehp_shield: 887, ehp_armor: 980, ehp_hull: 1088, hp_total: 1563,
  resist_shield_em: 0.125, resist_shield_thermal: 0.3, resist_shield_kinetic: 0.475, resist_shield_explosive: 0.5625,
  resist_armor_em: 0.66, resist_armor_thermal: 0.448, resist_armor_kinetic: 0.363, resist_armor_explosive: 0.235,
  resist_hull_em: 0.598, resist_hull_thermal: 0.598, resist_hull_kinetic: 0.598, resist_hull_explosive: 0.598,
  tank_sustained: 4.7, tank_burst: 4.7, shield_regen: 4.7, remote_rep: 0,
  cap_capacity: 250, cap_stable: 0, cap_stable_pct: 0, cap_lasts_s: 120.4, cap_delta: -0.83,
  max_speed: 3240.5, align_time: 4.69, signature: 201.3, warp_speed: 5,
  lock_range: 28125, scan_res: 825, sensor_strength: 9.6, max_targets: 4, mining_yield: 0,
  cpu_used: 135.75, cpu_total: 162.5, pg_used: 23.6, pg_total: 51.25, calibration_used: 0, calibration_total: 400,
  drone_bandwidth_used: 0, drone_bandwidth_total: 0, drone_bay_used: 0, drone_bay_total: 0,
  slots: { low: { used: 2, total: 4 } }, turret_hardpoints_free: 2, launcher_hardpoints_free: 2,
};

const RESULT = {
  contract: CONTRACT, valid: true, issues: [], pilot_used: "All 5", ship: "Rifter",
  engine: { name: "eve-fit-mcp", pyfa_version: "v2.62.3" }, stats: STATS, units: {}, missing_skills: [],
};

class FakeEngine implements FitEngine {
  calls: Array<[string, any]> = [];
  reply: any = RESULT;
  error?: string;

  async call(tool: string, args: Record<string, unknown>) {
    this.calls.push([tool, structuredClone(args)]);
    if (this.error) throw new Error(this.error);
    assert.equal(tool, "evaluate_fit");
    return this.reply;
  }
}

const skills: CharacterSkills = {
  levels: new Map([
    [3300, { trained: 5, active: 5, sp: 0 }],
    [3426, { trained: 5, active: 4, sp: 0 }], // alpha-limited: active level wins
    [12345, { trained: 0, active: 0, sp: 0 }],
  ]),
  total_sp: 0, unallocated_sp: 0, attributes: {},
};

test("stats are grouped and rounded", () => {
  const s: any = formatStats(RESULT, { skillsUsed: "All 5" });
  assert.equal(s.pilot, "All 5");
  assert.match(s.source, /Pyfa v2\.62\.3/);
  assert.equal(s.offense.dps, 55.1);
  assert.equal(s.defense.ehp, 2955);
  assert.equal(s.defense.resists_percent.shield.explosive, 56.3);
  assert.deepEqual(s.capacitor, { capacity_gj: 250, stable: false, lasts_s: 120, delta_gj_s: -0.83 });
  assert.deepEqual(s.fitting.cpu_tf, { used: 135.75, total: 162.5, free: 26.75, percent: 83.5 });
  assert.equal(s.fitting.drone_bandwidth, undefined);
  assert.equal(s.missing_skills, undefined);
  assert.equal(s.mining_yield_m3_s, undefined);
});

test("additive @1 fields: weapon groups, volley split, single-type EHP, prop-off navigation, cargo", () => {
  const r = {
    ...RESULT,
    stats: {
      ...STATS, weapon_optimal: 42000, weapon_falloff: 1, volley_weapon: 80, volley_drone: 3.2,
      missile_explosion_radius: 40.5, missile_explosion_velocity: 170.04,
      ehp_vs_em: 2100.4, ehp_vs_thermal: 2600, ehp_vs_kinetic: 3100, ehp_vs_explosive: 3300,
      max_speed_noprop: 456.25, align_time_noprop: 3.2, signature_noprop: 35,
      cargo_used: 5, cargo_total: 140,
    },
    weapon_groups: [
      { weapon: "Light Missile Launcher II", charge: "Scourge Light Missile", count: 2, dps: 40.123, hardpoint: "launcher",
        optimal: 42000, falloff: 1, explosion_radius: 40.5, explosion_velocity: 170.04 },
      { weapon: "125mm Gatling AutoCannon II", charge: null, count: 1, dps: 15, hardpoint: "turret",
        optimal: 1200, falloff: 4000, tracking: 0.512345 },
    ],
  };
  const s: any = formatStats(r, { skillsUsed: "" });
  assert.equal(s.offense.weapon_range_m, 42000, "missile primary: range, not optimal/falloff");
  assert.equal(s.offense.weapon_falloff_m, undefined);
  assert.deepEqual([s.offense.weapon_volley, s.offense.drone_volley], [80, 3.2]);
  assert.deepEqual([s.offense.missile_explosion_radius_m, s.offense.missile_explosion_velocity_m_s], [40.5, 170]);
  assert.deepEqual(s.offense.weapon_groups, [
    { weapon: "Light Missile Launcher II", charge: "Scourge Light Missile", count: 2, dps: 40.1,
      range_m: 42000, explosion_radius_m: 40.5, explosion_velocity_m_s: 170 },
    { weapon: "125mm Gatling AutoCannon II", count: 1, dps: 15, optimal_m: 1200, falloff_m: 4000, tracking: 0.5123 },
  ]);
  assert.deepEqual(s.defense.ehp_vs_single_damage_type, { em: 2100, thermal: 2600, kinetic: 3100, explosive: 3300 });
  assert.deepEqual(s.navigation.without_prop_module, { max_speed_m_s: 456.3, align_time_s: 3.2, signature_m: 35 });
  assert.deepEqual(s.fitting.cargo_m3, { used: 5, total: 140, free: 135, percent: 3.6 });
});

test("prop-off navigation is omitted when it equals the prop-on values", () => {
  const s: any = formatStats({ ...RESULT, stats: { ...STATS, max_speed_noprop: 3240.5, align_time_noprop: 4.69, signature_noprop: 201.3 } }, { skillsUsed: "" });
  assert.equal(s.navigation.without_prop_module, undefined);
  assert.equal(s.offense.weapon_groups, undefined);
});

test("stable capacitor reports the stable level, not 1e9 seconds", () => {
  const s: any = formatStats({ ...RESULT, stats: { ...STATS, cap_stable: 1, cap_stable_pct: 81.2, cap_lasts_s: 1e9 } }, { skillsUsed: "" });
  assert.deepEqual(s.capacitor, { capacity_gj: 250, stable: true, stable_at_percent: 81.2, delta_gj_s: -0.83 });
});

test("without a character, evaluate_fit gets only the EFT (All 5)", async () => {
  const engine = new FakeEngine();
  const s: any = await new FitStats(engine).compute({ eft: "[Rifter, T]" });
  assert.deepEqual(engine.calls, [["evaluate_fit", { eft: "[Rifter, T]" }]]);
  assert.match(s.skills_used, /level 5/);
});

test("character skills and implants are passed inline", async () => {
  const engine = new FakeEngine();
  engine.reply = {
    ...RESULT, pilot_used: "custom skills",
    missing_skills: [{ item: "Gyrostabilizer II", skill: "Weapon Upgrades", required: 4, have: 3 }],
  };
  const s: any = await new FitStats(engine).compute({ eft: "[Rifter, T]", skills, characterName: "Test Pilot", implants: [13219] });
  assert.deepEqual(engine.calls[0][1], { eft: "[Rifter, T]", skills: { "3300": 5, "3426": 4 }, implants: [13219] });
  assert.equal(s.pilot, "custom skills");
  assert.match(s.skills_used, /Test Pilot's trained skills .* 1 active implant/);
  assert.equal(s.missing_skills[0].skill, "Weapon Upgrades");
});

test("an unparseable fit comes back as valid=false with issues only", async () => {
  const engine = new FakeEngine();
  engine.reply = { ...RESULT, valid: false, issues: ["EFT must start with a [Ship, Fit name] header line"], stats: {} };
  const s: any = await new FitStats(engine).compute({ eft: "nope" });
  assert.equal(s.valid, false);
  assert.deepEqual(s.issues, ["EFT must start with a [Ship, Fit name] header line"]);
  assert.equal(s.offense, undefined);
});

test("an eve-fit without evaluate_fit is reported as too old", async () => {
  const engine = new FakeEngine();
  engine.error = "eve-fit evaluate_fit: Unknown tool: evaluate_fit";
  await assert.rejects(new FitStats(engine).compute({ eft: "[Rifter, T]" }), /no evaluate_fit tool; update eve-fit-mcp/);
  const old = new FakeEngine();
  old.reply = { fit_id: 1 };
  await assert.rejects(new FitStats(old).compute({ eft: "[Rifter, T]" }), /contract missing/);
});

test("EVE_FIT_COMMAND wins and can disable the integration", () => {
  const saved = { ...process.env };
  try {
    process.env.EVE_FIT_COMMAND = "uvx";
    process.env.EVE_FIT_ARGS = '["eve-fit-mcp", "--flag"]';
    process.env.EVE_FIT_DIR = "/nowhere";
    assert.deepEqual(eveFitLaunch(), { command: "uvx", args: ["eve-fit-mcp", "--flag"], cwd: undefined });
    process.env.EVE_FIT_ARGS = "-m eve_fit_mcp.server";
    assert.deepEqual(eveFitLaunch()?.args, ["-m", "eve_fit_mcp.server"]);
    process.env.EVE_FIT_COMMAND = "off";
    assert.equal(eveFitLaunch(), undefined);
    delete process.env.EVE_FIT_COMMAND;
    assert.equal(eveFitLaunch(), undefined, "EVE_FIT_DIR without a venv is not usable");
  } finally {
    for (const k of ["EVE_FIT_COMMAND", "EVE_FIT_ARGS", "EVE_FIT_DIR"]) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
});
