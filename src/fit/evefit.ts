import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Sde } from "../sde/db.js";
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

export const DEFAULT_PILOT = "All 5";

export interface StatsRequest {
  eft: string;
  skills?: CharacterSkills;
  character?: { id: number; name: string };
}

/** Pushes characters' skills into eve-fit custom pilots and turns get_stats output into the `stats` section. */
export class FitStats {
  /** character id -> fingerprint of the skills last saved as its pilot. */
  private saved = new Map<number, string>();

  constructor(private readonly engine: FitEngine) {}

  static pilotName(characterId: number) {
    return `eve-esi-mcp ${characterId}`;
  }

  /** Saves the character's active skill levels as an eve-fit pilot (base level 0, replace) and returns its name. */
  async pilotFor(sde: Sde, character: { id: number }, skills: CharacterSkills): Promise<{ pilot: string; skipped: string[] }> {
    const levels: Record<string, number> = {};
    for (const [id, l] of skills.levels) {
      if (l.active > 0) levels[sde.typeName(id)] = l.active;
    }
    const name = FitStats.pilotName(character.id);
    const fingerprint = JSON.stringify(Object.entries(levels).sort());
    if (this.saved.get(character.id) === fingerprint) return { pilot: name, skipped: [] };
    const skipped: string[] = [];
    // eve-fit rejects skill names its (Pyfa) game data does not know; drop those and retry.
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await this.engine.call("save_pilot", { name, base_level: 0, skills: levels, replace: true });
        this.saved.set(character.id, fingerprint);
        return { pilot: name, skipped };
      } catch (err) {
        const unknown = /Unknown skill '([^']+)'|Unknown skill "([^"]+)"/.exec((err as Error).message);
        const skill = unknown && (unknown[1] ?? unknown[2]);
        if (!skill || !(skill in levels)) throw err;
        delete levels[skill];
        skipped.push(skill);
      }
    }
    throw new Error("too many skills unknown to eve-fit");
  }

  /** Loads the fit into eve-fit, reads the full stats and closes it again. */
  async compute(sde: Sde, req: StatsRequest): Promise<Record<string, unknown>> {
    let pilot = DEFAULT_PILOT;
    let pilotNote = "All skills at level 5 (no character skills available).";
    const notes: string[] = [];
    if (req.skills && req.character) {
      try {
        const p = await this.pilotFor(sde, req.character, req.skills);
        pilot = p.pilot;
        pilotNote = `${req.character.name}'s trained skills (active levels).`;
        if (p.skipped.length) notes.push(`Skills unknown to eve-fit, treated as untrained: ${p.skipped.join(", ")}.`);
      } catch (err) {
        pilotNote = `All skills at level 5: could not load ${req.character.name}'s skills into eve-fit (${(err as Error).message}).`;
      }
    }
    const loaded = await this.engine.call("load_fit", { eft: req.eft, pilot });
    try {
      const s = await this.engine.call("get_stats", { fit_id: loaded.fit_id, full: true });
      return formatStats(s, { pilot, pilotNote, character: pilot === DEFAULT_PILOT ? undefined : req.character?.name, notes });
    } finally {
      await this.engine.call("close_fit", { fit_id: loaded.fit_id }).catch(() => undefined);
    }
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

/** Turns eve-fit's flat get_stats(full=true) dict into a grouped, rounded section. */
export function formatStats(s: any, meta: { pilot: string; pilotNote: string; character?: string; notes?: string[] }) {
  const resists = Object.fromEntries(
    LAYERS.map((l) => [l, Object.fromEntries(DAMAGE.map((d) => [d, pct(s[`resist_${l}_${d}`])]))]),
  );
  const stable = s.cap_stable >= 1;
  const missing = s.missing_skills && Object.keys(s.missing_skills).length ? s.missing_skills : undefined;
  const turretOptimal = n(s.weapon_optimal, 0);
  return {
    source: "eve-fit (Pyfa engine): skills, rigs, ship bonuses and module effects applied",
    pilot: meta.pilot,
    skills_used: meta.pilotNote,
    ...(meta.notes?.length ? { notes: meta.notes } : {}),
    valid: s.valid,
    ...(s.issues?.length ? { issues: s.issues } : {}),
    ...(missing ? { missing_skills: missing } : {}),
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
      ehp_by_layer: Object.fromEntries(LAYERS.map((l) => [l, n(s[`ehp_${l}`], 0)])),
      raw_hp: n(s.hp_total, 0),
      damage_profile: s.damage_profile,
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
