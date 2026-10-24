import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "../config.js";
import { log } from "../util.js";
import { SDE_SCHEMA_VERSION, buildSde, cleanupOldSde, fetchLatestBuild } from "./build.js";
import { Sde } from "./db.js";

interface Pointer {
  build: number;
  path: string;
  checked_at: string;
}

const CHECK_INTERVAL_MS = 24 * 3600 * 1000;

/** Owns the local SDE database: first-run build, daily update checks and hot swapping. */
export class SdeManager {
  private current?: Sde;
  private pending?: Promise<Sde>;
  private updating = false;

  constructor(private cfg: Config) {}

  private get pointerPath() {
    return join(this.cfg.home, "sde-current.json");
  }

  private readPointer(): Pointer | null {
    try {
      const p = JSON.parse(readFileSync(this.pointerPath, "utf8")) as Pointer;
      return existsSync(p.path) ? p : null;
    } catch {
      return null;
    }
  }

  private writePointer(p: Pointer) {
    writeFileSync(this.pointerPath, JSON.stringify(p, null, 2));
  }

  private static schemaOk(path: string): boolean {
    try {
      const db = new DatabaseSync(path, { readOnly: true });
      const v = (db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as any)?.value;
      db.close();
      return Number(v) === SDE_SCHEMA_VERSION;
    } catch {
      return false;
    }
  }

  status() {
    const p = this.readPointer();
    return {
      ready: !!this.current,
      building: !!this.pending || this.updating,
      build: this.current?.build ?? p?.build ?? null,
      checked_at: p?.checked_at ?? null,
    };
  }

  /** Returns the SDE, building it on first use (takes ~1 minute, ~100 MB download). */
  async get(): Promise<Sde> {
    if (this.current) return this.current;
    this.pending ??= this.load().finally(() => (this.pending = undefined));
    return this.pending;
  }

  private async load(): Promise<Sde> {
    const p = this.readPointer();
    if (p && SdeManager.schemaOk(p.path)) {
      this.current = new Sde(p.path);
      cleanupOldSde(this.cfg.home, p.path);
      return this.current;
    }
    const build = await fetchLatestBuild(this.cfg.userAgent);
    const path = await buildSde(this.cfg.home, build, this.cfg.userAgent);
    this.writePointer({ build, path, checked_at: new Date().toISOString() });
    this.current = new Sde(path);
    cleanupOldSde(this.cfg.home, path);
    return this.current;
  }

  /** Checks for a newer SDE at most once a day and swaps it in when built. */
  async maybeUpdate(force = false): Promise<{ updated: boolean; build: number | null }> {
    const p = this.readPointer();
    if (!p || this.updating) return { updated: false, build: p?.build ?? null };
    if (!force && Date.now() - Date.parse(p.checked_at) < CHECK_INTERVAL_MS) return { updated: false, build: p.build };
    this.updating = true;
    try {
      const latest = await fetchLatestBuild(this.cfg.userAgent);
      if (latest === p.build && SdeManager.schemaOk(p.path)) {
        this.writePointer({ ...p, checked_at: new Date().toISOString() });
        return { updated: false, build: latest };
      }
      const path = await buildSde(this.cfg.home, latest, this.cfg.userAgent);
      this.writePointer({ build: latest, path, checked_at: new Date().toISOString() });
      const old = this.current;
      this.current = new Sde(path);
      old?.close();
      cleanupOldSde(this.cfg.home, path);
      return { updated: true, build: latest };
    } catch (err) {
      log("SDE update check failed:", (err as Error).message);
      return { updated: false, build: p.build };
    } finally {
      this.updating = false;
    }
  }
}
