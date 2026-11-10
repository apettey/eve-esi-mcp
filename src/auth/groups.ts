import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UserError, norm } from "../util.js";

/** A group member. The name is kept so a member who logs out still shows by name and comes back on login. */
export interface GroupMember {
  id: number;
  name: string;
}

export interface CharacterGroup {
  name: string;
  note?: string;
  members: GroupMember[];
  updated_at: string;
}

interface GroupFile {
  groups: Record<string, CharacterGroup>;
}

/**
 * The user's own character groups (e.g. mirroring in-game access lists, which ESI cannot read), in groups.json in
 * the data directory. Kept apart from characters.json so token writes and group edits never race on one file.
 */
export class GroupStore {
  private data: GroupFile = { groups: {} };
  private path: string;

  constructor(home: string) {
    this.path = join(home, "groups.json");
    this.reload();
  }

  /** Re-reads the file so edits from another server process are picked up. */
  reload() {
    this.data = existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as GroupFile) : { groups: {} };
    this.data.groups ??= {};
  }

  private save() {
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }

  list(): CharacterGroup[] {
    this.reload();
    return Object.values(this.data.groups).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The group with this name (case-insensitive), or undefined. A leading "group:" is ignored. */
  find(ref: string): CharacterGroup | undefined {
    this.reload();
    return this.data.groups[norm(stripPrefix(ref))];
  }

  /** Like find(), but throws an error listing the known groups. */
  get(ref: string): CharacterGroup {
    const g = this.find(ref);
    if (g) return g;
    const names = this.list().map((x) => x.name);
    throw new UserError(
      `No character group "${stripPrefix(ref)}". ` +
        (names.length ? `Groups: ${names.join(", ")}.` : "No groups yet; create one with character_groups action 'create'."),
    );
  }

  create(name: string, note?: string): CharacterGroup {
    const clean = stripPrefix(name).trim();
    if (!clean) throw new UserError("A group needs a name.");
    this.reload();
    if (this.data.groups[norm(clean)]) throw new UserError(`Group "${this.data.groups[norm(clean)].name}" already exists.`);
    const g: CharacterGroup = { name: clean, note: note || undefined, members: [], updated_at: new Date().toISOString() };
    this.data.groups[norm(clean)] = g;
    this.save();
    return g;
  }

  /** Applies a change to one group and saves it. */
  update(ref: string, fn: (g: CharacterGroup) => void): CharacterGroup {
    const g = this.get(ref);
    fn(g);
    g.members.sort((a, b) => a.name.localeCompare(b.name));
    g.updated_at = new Date().toISOString();
    this.save();
    return g;
  }

  rename(ref: string, to: string): CharacterGroup {
    const g = this.get(ref);
    const clean = stripPrefix(to).trim();
    if (!clean) throw new UserError("A group needs a name.");
    const clash = this.data.groups[norm(clean)];
    if (clash && clash !== g) throw new UserError(`Group "${clash.name}" already exists.`);
    delete this.data.groups[norm(g.name)];
    g.name = clean;
    g.updated_at = new Date().toISOString();
    this.data.groups[norm(clean)] = g;
    this.save();
    return g;
  }

  remove(ref: string): CharacterGroup {
    const g = this.get(ref);
    delete this.data.groups[norm(g.name)];
    this.save();
    return g;
  }

  /** Names of the groups a character is in. */
  groupsOf(id: number): string[] {
    return this.list().filter((g) => g.members.some((m) => m.id === id)).map((g) => g.name);
  }
}

function stripPrefix(ref: string) {
  return ref.replace(/^\s*group:\s*/i, "");
}
