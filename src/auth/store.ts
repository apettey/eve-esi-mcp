import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UserError, norm } from "../util.js";

export interface StoredCharacter {
  id: number;
  name: string;
  owner_hash: string;
  scopes: string[];
  refresh_token: string;
  access_token?: string;
  expires_at?: number;
  added_at: string;
  last_refresh_error?: string;
}

interface StoreFile {
  active_character_id: number | null;
  characters: Record<string, StoredCharacter>;
}

/**
 * Persists authorized characters (including refresh tokens) to characters.json in the data directory.
 * The file is written with owner-only permissions where the platform supports it.
 */
export class CharacterStore {
  private data: StoreFile;
  private path: string;

  constructor(home: string) {
    this.path = join(home, "characters.json");
    this.data = existsSync(this.path)
      ? (JSON.parse(readFileSync(this.path, "utf8")) as StoreFile)
      : { active_character_id: null, characters: {} };
  }

  /** Re-reads the file so a login from the CLI is picked up by a running server. */
  reload() {
    if (existsSync(this.path)) this.data = JSON.parse(readFileSync(this.path, "utf8")) as StoreFile;
  }

  private save() {
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
    try { chmodSync(this.path, 0o600); } catch { /* not supported on all platforms */ }
  }

  list(): StoredCharacter[] {
    return Object.values(this.data.characters).sort((a, b) => a.name.localeCompare(b.name));
  }

  get activeId(): number | null {
    const id = this.data.active_character_id;
    if (id && this.data.characters[id]) return id;
    const first = this.list()[0];
    return first ? first.id : null;
  }

  get(id: number): StoredCharacter | undefined {
    return this.data.characters[id];
  }

  upsert(c: StoredCharacter) {
    const existing = this.data.characters[c.id];
    // A different owner hash means the character was transferred; drop the old grant.
    this.data.characters[c.id] = existing && existing.owner_hash === c.owner_hash ? { ...existing, ...c } : c;
    if (!this.data.active_character_id) this.data.active_character_id = c.id;
    this.save();
  }

  updateTokens(id: number, patch: Partial<StoredCharacter>) {
    const c = this.data.characters[id];
    if (!c) return;
    Object.assign(c, patch);
    this.save();
  }

  remove(id: number) {
    delete this.data.characters[id];
    if (this.data.active_character_id === id) this.data.active_character_id = this.list()[0]?.id ?? null;
    this.save();
  }

  setActive(id: number) {
    this.data.active_character_id = id;
    this.save();
  }

  /** Resolves a character reference (id or case-insensitive name/prefix) to a stored character. */
  resolve(ref?: string | number | null): StoredCharacter {
    this.reload();
    const all = this.list();
    if (!all.length) {
      throw new UserError("No characters are logged in. Call character_login to authorize an EVE character first.");
    }
    if (ref == null || ref === "") {
      const c = this.activeId ? this.get(this.activeId) : undefined;
      if (!c) throw new UserError("No active character. Call character_select.");
      return c;
    }
    const asNum = Number(ref);
    if (Number.isInteger(asNum) && this.data.characters[asNum]) return this.data.characters[asNum];
    const n = norm(String(ref));
    const exact = all.find((c) => norm(c.name) === n);
    if (exact) return exact;
    const partial = all.filter((c) => norm(c.name).includes(n));
    if (partial.length === 1) return partial[0];
    throw new UserError(
      `Character "${ref}" is not logged in${partial.length > 1 ? " (ambiguous)" : ""}. Known characters: ${all.map((c) => c.name).join(", ")}.`,
    );
  }
}
