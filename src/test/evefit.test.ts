import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PILOT, FitStats, eveFitLaunch, formatStats, type FitEngine } from "../fit/evefit.js";
import type { Sde } from "../sde/db.js";
import type { CharacterSkills } from "../skills.js";

// eve-fit itself is not needed: a fake engine records calls and answers like eve-fit's tools.
const NAMES: Record<number, string> = { 3300: "Gunnery", 3426: "CPU Management", 99999: "Brand New Skill" };
const sde = { typeName: (id: number) => NAMES[id] ?? `#${id}` } as unknown as Sde;

const STATS = {
  ship: "Rifter", valid: true, issues: [], missing_skills: {},
  dps_total: 55.123, dps_weapon: 55.123, dps_drone: 0, volley: 83.2,
  weapon_optimal: 750, weapon_falloff: 9675, weapon_tracking: 393.75,
  ehp_total: 2955.4, ehp_shield: 887, ehp_armor: 980, ehp_hull: 1088, hp_total: 1563,
  resist_shield_em: 0.125, resist_shield_thermal: 0.3, resist_shield_kinetic: 0.475, resist_shield_explosive: 0.5625,
  resist_armor_em: 0.66, resist_armor_thermal: 0.448, resist_armor_kinetic: 0.363, resist_armor_explosive: 0.235,
  resist_hull_em: 0.598, resist_hull_thermal: 0.598, resist_hull_kinetic: 0.598, resist_hull_explosive: 0.598,
  damage_profile: { em: 25, thermal: 25, kinetic: 25, explosive: 25 },
  tank_sustained: 4.7, tank_burst: 4.7, shield_regen: 4.7, remote_rep: 0,
  cap_capacity: 250, cap_stable: 0, cap_stable_pct: 0, cap_lasts_s: 120.4, cap_delta: -0.83,
  max_speed: 3240.5, align_time: 4.69, signature: 201.3, warp_speed: 5,
  lock_range: 28125, scan_res: 825, sensor_strength: 9.6, max_targets: 4, mining_yield: 0,
  cpu_used: 135.75, cpu_total: 162.5, pg_used: 23.6, pg_total: 51.25, calibration_used: 0, calibration_total: 400,
  drone_bandwidth_used: 0, drone_bandwidth_total: 0, drone_bay_used: 0, drone_bay_total: 0,
  slots: { low: { used: 2, total: 4 } }, turret_hardpoints_free: 2, launcher_hardpoints_free: 2,
};

class FakeEngine implements FitEngine {
  calls: Array<[string, any]> = [];
  rejectSkills = new Set<string>();
  failSave = false;

  async call(tool: string, args: Record<string, unknown>) {
    this.calls.push([tool, structuredClone(args)]);
    switch (tool) {
      case "save_pilot": {
        if (this.failSave) throw new Error("eve-fit save_pilot: disk full");
        const bad = Object.keys(args.skills as object).find((s) => this.rejectSkills.has(s));
        if (bad) throw new Error(`eve-fit save_pilot: Unknown skill '${bad}'`);
        return { name: args.name };
      }
      case "load_fit": return { fit_id: 7 };
      case "get_stats": return STATS;
      case "close_fit": return { closed: args.fit_id };
      default: throw new Error(`unexpected tool ${tool}`);
    }
  }
  tools() { return this.calls.map((c) => c[0]); }
}

const skills: CharacterSkills = {
  levels: new Map([
    [3300, { trained: 5, active: 5, sp: 0 }],
    [3426, { trained: 5, active: 4, sp: 0 }], // alpha-limited: active level wins
    [99999, { trained: 1, active: 1, sp: 0 }],
    [12345, { trained: 0, active: 0, sp: 0 }],
  ]),
  total_sp: 0, unallocated_sp: 0, attributes: {},
};
const character = { id: 90000001, name: "Test Pilot" };

test("stats are grouped and rounded", () => {
  const s: any = formatStats(STATS, { pilot: DEFAULT_PILOT, pilotNote: "All 5" });
  assert.equal(s.offense.dps, 55.1);
  assert.equal(s.defense.ehp, 2955);
  assert.equal(s.defense.resists_percent.shield.explosive, 56.3);
  assert.deepEqual(s.capacitor, { capacity_gj: 250, stable: false, lasts_s: 120, delta_gj_s: -0.83 });
  assert.deepEqual(s.fitting.cpu_tf, { used: 135.75, total: 162.5, free: 26.75, percent: 83.5 });
  assert.equal(s.fitting.drone_bandwidth, undefined);
  assert.equal(s.missing_skills, undefined);
  assert.equal(s.mining_yield_m3_s, undefined);
});

test("without a character, stats use All 5 and the fit is closed", async () => {
  const engine = new FakeEngine();
  const s: any = await new FitStats(engine).compute(sde, { eft: "[Rifter, T]" });
  assert.deepEqual(engine.tools(), ["load_fit", "get_stats", "close_fit"]);
  assert.equal(engine.calls[0][1].pilot, "All 5");
  assert.equal(s.pilot, "All 5");
  assert.match(s.skills_used, /level 5/);
});

test("character skills become a cached custom pilot", async () => {
  const engine = new FakeEngine();
  const fs = new FitStats(engine);
  const s: any = await fs.compute(sde, { eft: "[Rifter, T]", skills, character });
  const [tool, args] = engine.calls[0];
  assert.equal(tool, "save_pilot");
  assert.deepEqual(args, {
    name: FitStats.pilotName(character.id), base_level: 0, replace: true,
    skills: { Gunnery: 5, "CPU Management": 4, "Brand New Skill": 1 },
  });
  assert.equal(engine.calls[1][1].pilot, FitStats.pilotName(character.id));
  assert.match(s.skills_used, /Test Pilot/);

  await fs.compute(sde, { eft: "[Rifter, T]", skills, character });
  assert.equal(engine.tools().filter((t) => t === "save_pilot").length, 1, "unchanged skills are not re-saved");
});

test("skills eve-fit does not know are dropped and reported", async () => {
  const engine = new FakeEngine();
  engine.rejectSkills.add("Brand New Skill");
  const s: any = await new FitStats(engine).compute(sde, { eft: "[Rifter, T]", skills, character });
  assert.deepEqual(engine.tools(), ["save_pilot", "save_pilot", "load_fit", "get_stats", "close_fit"]);
  assert.deepEqual(engine.calls[1][1].skills, { Gunnery: 5, "CPU Management": 4 });
  assert.match(s.notes[0], /Brand New Skill/);
});

test("a failing pilot save falls back to All 5, labelled", async () => {
  const engine = new FakeEngine();
  engine.failSave = true;
  const s: any = await new FitStats(engine).compute(sde, { eft: "[Rifter, T]", skills, character });
  assert.equal(engine.calls[1][1].pilot, "All 5");
  assert.equal(s.pilot, "All 5");
  assert.match(s.skills_used, /could not load Test Pilot's skills.*disk full/);
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
