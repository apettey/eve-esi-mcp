import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CharacterSkills } from "../skills.js";
import { VERSION } from "../config.js";
import { log, round } from "../util.js";

/**
 * Optional integration with eve-fit-mcp (https://github.com/apettey/eve-fit-mcp), a Pyfa-based fitting engine,
 * for skill-, rig- and module-accurate fit stats. eve-fit is spawned lazily as an MCP stdio server and reused.
 */

export interface EveFitLaunch {
  command: string;
  args: string[];
  cwd?: string;
}

/** Minimal surface of an MCP client used here, so tests can substitute a fake engine. */
export interface FitEngine {
  call(tool: string, args: Record<string, unknown>): Promise<any>;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

function venvPython(dir: string): string | undefined {
  for (const p of [join(dir, ".venv", "Scripts", "python.exe"), join(dir, ".venv", "bin", "python")]) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

function fromDir(dir: string): EveFitLaunch | undefined {
  const python = venvPython(dir);
  return python && existsSync(join(dir, "eve_fit_mcp")) ? { command: python, args: ["-m", "eve_fit_mcp.server"], cwd: dir } : undefined;
}

function parseArgs(s: string | undefined): string[] {
  if (!s) return [];
  if (s.startsWith("[")) return (JSON.parse(s) as unknown[]).map(String);
  return s.split(/\s+/).filter(Boolean);
}

/**
 * How to launch eve-fit, from (in order) EVE_FIT_COMMAND (+ EVE_FIT_ARGS, EVE_FIT_CWD), EVE_FIT_DIR (a checkout with
 * a .venv), or a sibling `eve-fit-mcp` checkout next to this package. EVE_FIT_COMMAND=off disables the integration.
 */
export function eveFitLaunch(): EveFitLaunch | undefined {
  const command = env("EVE_FIT_COMMAND");
  if (command && /^(off|false|none|disabled?)$/i.test(command)) return undefined;
  if (command) return { command, args: parseArgs(env("EVE_FIT_ARGS")), cwd: env("EVE_FIT_CWD") };
  const dir = env("EVE_FIT_DIR");
  if (dir) return fromDir(dir);
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  return fromDir(join(pkgRoot, "..", "eve-fit-mcp"));
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** eve-fit over MCP stdio: started on first use, restarted on the next call if it dies. */
export class EveFitClient implements FitEngine {
  private ready?: Promise<Client>;
  private stderrTail = "";

  constructor(
    readonly launch: EveFitLaunch,
    private readonly startupTimeoutMs = 120_000,
    private readonly callTimeoutMs = 60_000,
  ) {}

  private start(): Promise<Client> {
    this.stderrTail = "";
    const transport = new StdioClientTransport({
      command: this.launch.command,
      args: this.launch.args,
      cwd: this.launch.cwd,
      env: process.env as Record<string, string>,
      stderr: "pipe",
    });
    transport.stderr?.on("data", (d: Buffer) => { this.stderrTail = (this.stderrTail + d.toString()).slice(-2000); });
    const client = new Client({ name: "eve-esi-mcp", version: VERSION });
    client.onclose = () => { this.ready = undefined; };
    const kill = () => { if (transport.pid) try { process.kill(transport.pid); } catch { /* already gone */ } };
    process.once("exit", kill);
    log(`Starting eve-fit: ${this.launch.command} ${this.launch.args.join(" ")}`);
    return client.connect(transport).then(() => client, (err) => {
      process.off("exit", kill);
      const tail = this.stderrTail.trim().split(/\r?\n/).slice(-3).join(" | ");
      throw new Error(`could not start eve-fit (${(err as Error).message})${tail ? `: ${tail}` : ""}`);
    });
  }

  async call(tool: string, args: Record<string, unknown>): Promise<any> {
    // A slow first boot (Pyfa DB build) keeps running in the background; a later call picks it up.
    const pending = (this.ready ??= this.start());
    pending.catch(() => { if (this.ready === pending) this.ready = undefined; });
    const client = await withTimeout(pending, this.startupTimeoutMs, "eve-fit startup");
    const res: any = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: this.callTimeoutMs });
    const text = res.content?.find((c: any) => c.type === "text")?.text;
    if (res.isError) throw new Error(`eve-fit ${tool}: ${text ?? "error"}`);
    if (res.structuredContent) return res.structuredContent;
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return { text };
    }
  }
}

export const CONTRACT = "eve-fit/evaluate_fit@1";

export interface StatsRequest {
  eft: string;
  skills?: CharacterSkills;
  /** Whose skills these are, for labelling. */
  characterName?: string;
  /** Active implant type ids of that character. */
  implants?: number[];
  /** Charges loaded from cargo for this calculation only (see fit/ammo.ts), and weapons left without one. */
  assumedCharges?: string[];
  unloadedWeapons?: string[];
}

/** Evaluates fits with eve-fit's stateless evaluate_fit and turns the result into the `stats` section. */
export class FitStats {
  constructor(private readonly engine: FitEngine) {}

  async compute(req: StatsRequest): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = { eft: req.eft };
    if (req.skills) {
      // Active levels (alpha clones are capped); unlisted skills count as untrained.
      const levels: Record<string, number> = {};
      for (const [id, l] of req.skills.levels) if (l.active > 0) levels[String(id)] = l.active;
      args.skills = levels;
    }
    if (req.implants?.length) args.implants = req.implants;
    let r: any;
    try {
      r = await this.engine.call("evaluate_fit", args);
    } catch (err) {
      if (/unknown tool|not found/i.test((err as Error).message)) {
        throw new Error("this eve-fit-mcp has no evaluate_fit tool; update eve-fit-mcp");
      }
      throw err;
    }
    if (typeof r?.contract !== "string" || !r.contract.startsWith("eve-fit/evaluate_fit@1")) {
      throw new Error(`unsupported eve-fit response (contract ${r?.contract ?? "missing"}, expected ${CONTRACT})`);
    }
    const skillsUsed = req.skills
      ? `${req.characterName ?? "Character"}'s trained skills (active levels)` +
        (req.implants?.length ? ` with ${req.implants.length} active implant(s).` : ".")
      : "All skills at level 5 (no character skills available).";
    return formatStats(r, { skillsUsed, assumedCharges: req.assumedCharges, unloadedWeapons: req.unloadedWeapons });
  }
}

const LAYERS = ["shield", "armor", "hull"] as const;
const DAMAGE = ["em", "thermal", "kinetic", "explosive"] as const;

const n = (v: unknown, digits = 1) => (typeof v === "number" && Number.isFinite(v) ? round(v, digits) : undefined);
const pct = (v: unknown) => (typeof v === "number" ? round(v * 100, 1) : undefined);

function resource(s: any, key: string) {
  const used = s[`${key}_used`], total = s[`${key}_total`];
  if (typeof used !== "number" || typeof total !== "number" || (!used && !total)) return undefined;
  return { used: n(used, 2), total: n(total, 2), free: n(total - used, 2), percent: total ? round((used / total) * 100, 1) : null };
}

/** Turns an evaluate_fit result (raw numbers, resists as fractions) into a grouped, rounded section. */
export function formatStats(r: any, meta: { skillsUsed: string; assumedCharges?: string[]; unloadedWeapons?: string[] }) {
  const s = r.stats ?? {};
  const head = {
    source: `eve-fit (Pyfa${r.engine?.pyfa_version ? " " + r.engine.pyfa_version : ""}): skills, rigs, ship bonuses and module effects applied`,
    pilot: r.pilot_used ?? undefined,
    skills_used: meta.skillsUsed,
    ...(meta.assumedCharges?.length ? { assumed_charges: meta.assumedCharges } : {}),
    ...(meta.unloadedWeapons?.length ? { unloaded_weapons: meta.unloadedWeapons } : {}),
    valid: r.valid,
    ...(r.issues?.length ? { issues: r.issues } : {}),
    ...(r.missing_skills?.length ? { missing_skills: r.missing_skills } : {}),
  };
  // A fit eve-fit could not parse comes back as valid=false with issues and no numbers.
  if (!Object.keys(s).length) return head;
  const resists = Object.fromEntries(
    LAYERS.map((l) => [l, Object.fromEntries(DAMAGE.map((d) => [d, pct(s[`resist_${l}_${d}`])]))]),
  );
  const stable = s.cap_stable >= 1;
  const turretOptimal = n(s.weapon_optimal, 0);
  return {
    ...head,
    offense: {
      dps: n(s.dps_total),
      weapon_dps: n(s.dps_weapon),
      drone_dps: n(s.dps_drone),
      volley: n(s.volley),
      ...(turretOptimal ? {
        weapon_optimal_m: turretOptimal,
        weapon_falloff_m: n(s.weapon_falloff, 0),
        weapon_tracking: n(s.weapon_tracking, 4),
      } : {}),
    },
    defense: {
      ehp: n(s.ehp_total, 0),
      ehp_vs: "omni damage (25% each type)",
      ehp_by_layer: Object.fromEntries(LAYERS.map((l) => [l, n(s[`ehp_${l}`], 0)])),
      raw_hp: n(s.hp_total, 0),
      resists_percent: resists,
      sustained_tank_ehp_s: n(s.tank_sustained),
      burst_tank_ehp_s: n(s.tank_burst),
      passive_shield_regen_ehp_s: n(s.shield_regen),
      ...(s.remote_rep ? { remote_rep_hp_s: n(s.remote_rep) } : {}),
    },
    capacitor: {
      capacity_gj: n(s.cap_capacity, 0),
      stable,
      ...(stable ? { stable_at_percent: n(s.cap_stable_pct) } : { lasts_s: n(s.cap_lasts_s, 0) }),
      delta_gj_s: n(s.cap_delta, 2),
    },
    navigation: {
      max_speed_m_s: n(s.max_speed),
      align_time_s: n(s.align_time, 2),
      signature_m: n(s.signature),
      warp_speed_au_s: n(s.warp_speed, 2),
    },
    targeting: {
      lock_range_m: n(s.lock_range, 0),
      scan_resolution_mm: n(s.scan_res),
      sensor_strength: n(s.sensor_strength),
      max_targets: n(s.max_targets, 0),
    },
    fitting: {
      cpu_tf: resource(s, "cpu"),
      powergrid_mw: resource(s, "pg"),
      calibration: resource(s, "calibration"),
      drone_bandwidth: resource(s, "drone_bandwidth"),
      drone_bay_m3: resource(s, "drone_bay"),
      slots: s.slots,
      turret_hardpoints_free: s.turret_hardpoints_free,
      launcher_hardpoints_free: s.launcher_hardpoints_free,
    },
    ...(s.mining_yield ? { mining_yield_m3_s: n(s.mining_yield, 2) } : {}),
  };
}

let shared: FitStats | null | undefined;

/** The process-wide FitStats, or null when eve-fit is not configured. Nothing is spawned until the first compute(). */
export function fitStats(): FitStats | null {
  if (shared === undefined) {
    const launch = eveFitLaunch();
    shared = launch ? new FitStats(new EveFitClient(launch)) : null;
  }
  return shared;
}

export const EVE_FIT_NOT_CONFIGURED =
  "Accurate stats (EHP, DPS, cap, speed, skill-applied CPU/PG) need eve-fit-mcp: set EVE_FIT_DIR or EVE_FIT_COMMAND (see README).";
