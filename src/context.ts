import type { Config } from "./config.js";
import { CharacterStore, type StoredCharacter } from "./auth/store.js";
import { Sso } from "./auth/sso.js";
import { Esi } from "./esi/client.js";
import { Resolver } from "./esi/resolver.js";
import { Zkill } from "./zkill.js";
import { SdeManager } from "./sde/manager.js";
import type { Sde } from "./sde/db.js";
import { GroupStore } from "./auth/groups.js";
import { syncGroup } from "./access-lists.js";
import { UserError, norm } from "./util.js";

/** Shared services handed to every tool. */
export class Ctx {
  readonly store: CharacterStore;
  readonly sso: Sso;
  readonly esi: Esi;
  readonly sdeManager: SdeManager;
  readonly resolver: Resolver;
  readonly zkill: Zkill;

  constructor(readonly cfg: Config) {
    this.store = new CharacterStore(cfg.home);
    this.sso = new Sso(cfg, this.store);
    this.esi = new Esi(cfg, this.sso);
    this.sdeManager = new SdeManager(cfg);
    this.resolver = new Resolver(cfg.home, this.esi, () => this.sde());
    this.zkill = new Zkill(cfg.userAgent);
  }

  sde(): Promise<Sde> {
    return this.sdeManager.get();
  }

  /** The requested character, or the active one. Throws an actionable error when none is logged in. */
  character(ref?: string | number | null): StoredCharacter {
    return this.store.resolve(ref);
  }

  /** The user's character groups (groups.json), created on first use. */
  get groups(): GroupStore {
    return (this._groups ??= new GroupStore(this.cfg.home));
  }
  private _groups?: GroupStore;

  /**
   * Resolves a list of character references where any entry may also name a character group (exactly, or as
   * "group:Name"); groups expand to their logged-in members, and a group that follows an in-game access list is
   * re-read from ESI first. Deduplicated, in order. Members who aren't logged in here are returned in `skipped`, and
   * access lists that couldn't be read in `warnings`, so tools can say so instead of failing.
   */
  async characters(refs: Array<string | number>): Promise<{ characters: StoredCharacter[]; skipped: string[]; warnings: string[] }> {
    const out = new Map<number, StoredCharacter>();
    const skipped: string[] = [];
    const warnings: string[] = [];
    for (const ref of refs) {
      const s = String(ref);
      const isExplicit = /^\s*group:/i.test(s);
      let group = isExplicit || !this.isExactCharacter(s) ? this.groups.find(s) : undefined;
      if (isExplicit && !group) this.groups.get(s); // throws, listing the groups
      if (group?.access_list) {
        const synced = await syncGroup(this, group);
        group = synced.group;
        if (synced.warning) warnings.push(synced.warning);
      }
      if (group) {
        if (!group.members.length) throw new UserError(`Character group "${group.name}" has no members.`);
        for (const m of group.members) {
          const c = this.store.get(m.id);
          if (c) out.set(c.id, c);
          else skipped.push(`${m.name} (in group ${group.name}, not logged in)`);
        }
      } else {
        const c = this.character(ref);
        out.set(c.id, c);
      }
    }
    return { characters: [...out.values()], skipped, warnings };
  }

  private isExactCharacter(ref: string): boolean {
    this.store.reload();
    const n = norm(ref);
    return this.store.list().some((c) => norm(c.name) === n || String(c.id) === ref.trim());
  }

  /** Like character(), but returns undefined when no characters are logged in (for optional enrichment). */
  maybeCharacter(ref?: string | number | null): StoredCharacter | undefined {
    if (ref != null && ref !== "") return this.store.resolve(ref);
    this.store.reload();
    return this.store.activeId ? this.store.get(this.store.activeId) : undefined;
  }
}
