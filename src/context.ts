import type { Config } from "./config.js";
import { CharacterStore, type StoredCharacter } from "./auth/store.js";
import { Sso } from "./auth/sso.js";
import { Esi } from "./esi/client.js";
import { Resolver } from "./esi/resolver.js";
import { SdeManager } from "./sde/manager.js";
import type { Sde } from "./sde/db.js";

/** Shared services handed to every tool. */
export class Ctx {
  readonly store: CharacterStore;
  readonly sso: Sso;
  readonly esi: Esi;
  readonly sdeManager: SdeManager;
  readonly resolver: Resolver;

  constructor(readonly cfg: Config) {
    this.store = new CharacterStore(cfg.home);
    this.sso = new Sso(cfg, this.store);
    this.esi = new Esi(cfg, this.sso);
    this.sdeManager = new SdeManager(cfg);
    this.resolver = new Resolver(cfg.home, this.esi, () => this.sde());
  }

  sde(): Promise<Sde> {
    return this.sdeManager.get();
  }

  /** The requested character, or the active one. Throws an actionable error when none is logged in. */
  character(ref?: string | number | null): StoredCharacter {
    return this.store.resolve(ref);
  }

  /** Like character(), but returns undefined when no characters are logged in (for optional enrichment). */
  maybeCharacter(ref?: string | number | null): StoredCharacter | undefined {
    if (ref != null && ref !== "") return this.store.resolve(ref);
    this.store.reload();
    return this.store.activeId ? this.store.get(this.store.activeId) : undefined;
  }
}
