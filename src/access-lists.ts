// In-game access lists (ESI, compatibility date 2026-05-19 and later) and character groups that follow them.
import type { Ctx } from "./context.js";
import type { StoredCharacter } from "./auth/store.js";
import type { CharacterGroup, GroupMember } from "./auth/groups.js";
import { UserError, mapLimit, norm } from "./util.js";

export const ACCESS_SCOPE = "esi-access.read_lists.v1";

type Access = "Unspecified" | "Allowed" | "Blocked" | "Manager" | "Admin";

export interface AccessListDetail {
  id: number;
  name: string;
  description: string;
  membership: {
    allow_everyone: boolean;
    characters?: Array<{ character_id: number; access: Access }>;
    corporations?: Array<{ corporation_id: number; access: Access }>;
    alliances?: Array<{ alliance_id: number; access: Access }>;
  };
}

/** Every access list the character is a Manager or Admin of, with members. */
export async function readAccessLists(ctx: Ctx, c: StoredCharacter): Promise<AccessListDetail[]> {
  const listing = await ctx.esi.get<{ access_lists: Array<{ id: number }> }>(
    `/characters/${c.id}/access-lists`, { character: c, scope: ACCESS_SCOPE },
  );
  return mapLimit(listing.access_lists, 4, (l) => readAccessList(ctx, c, l.id));
}

export function readAccessList(ctx: Ctx, c: StoredCharacter, id: number): Promise<AccessListDetail> {
  return ctx.esi.get<AccessListDetail>(`/characters/${c.id}/access-lists/${id}`, { character: c, scope: ACCESS_SCOPE });
}

/** An access list by id, exact name or unique part of its name (case-insensitive). */
export async function findAccessList(ctx: Ctx, c: StoredCharacter, ref: string): Promise<AccessListDetail> {
  const lists = await readAccessLists(ctx, c);
  const n = norm(ref);
  const hit = lists.find((l) => String(l.id) === ref.trim()) ?? lists.find((l) => norm(l.name) === n);
  if (hit) return hit;
  const partial = lists.filter((l) => norm(l.name).includes(n));
  if (partial.length === 1) return partial[0];
  throw new UserError(
    `${c.name} manages no access list ${partial.length > 1 ? "uniquely " : ""}matching "${ref}". ` +
      (lists.length ? `Their access lists: ${lists.map((l) => `${l.name} (${l.id})`).join(", ")}.` : "They manage no access lists.") +
      " ESI only shows lists the character is a Manager or Admin of.",
  );
}

/**
 * The characters on a list who belong in the group: every access level but Blocked, minus `exclude`. Names come
 * from the logged-in characters first, then the resolver. Corporations and alliances are returned as `others`.
 */
export async function listMembers(ctx: Ctx, l: AccessListDetail, exclude: GroupMember[] = []) {
  const skip = new Set(exclude.map((m) => m.id));
  const ids = (l.membership.characters ?? []).filter((m) => m.access !== "Blocked" && !skip.has(m.character_id)).map((m) => m.character_id);
  const unknown = ids.filter((id) => !ctx.store.get(id));
  const orgs = [
    ...(l.membership.corporations ?? []).filter((m) => m.access !== "Blocked").map((m) => m.corporation_id),
    ...(l.membership.alliances ?? []).filter((m) => m.access !== "Blocked").map((m) => m.alliance_id),
  ];
  const names = unknown.length || orgs.length ? await ctx.resolver.entities([...unknown, ...orgs]) : new Map();
  const members: GroupMember[] = ids.map((id) => ({ id, name: ctx.store.get(id)?.name ?? names.get(id)?.name ?? `Character ${id}` }));
  const others = orgs.map((id) => names.get(id)?.name ?? `Entity ${id}`);
  if (l.membership.allow_everyone) others.unshift("everyone (allow_everyone is on)");
  return { members, others };
}

/**
 * Re-reads a linked group's access list and stores the members. On failure the group keeps its last members and the
 * error comes back as a warning, so a tool using the group still runs.
 */
export async function syncGroup(ctx: Ctx, g: CharacterGroup): Promise<{ group: CharacterGroup; warning?: string }> {
  const link = g.access_list;
  if (!link) return { group: g };
  try {
    const via = ctx.store.get(link.via.id);
    if (!via) throw new UserError(`${link.via.name}, who reads this access list, is not logged in. Log them in again (character_login).`);
    const l = await readAccessList(ctx, via, link.id);
    const { members, others } = await listMembers(ctx, l, link.exclude);
    const group = ctx.groups.update(g.name, (x) => {
      x.members = members;
      x.access_list = { ...link, name: l.name, others: others.length ? others : undefined, synced_at: new Date().toISOString() };
    });
    return { group };
  } catch (err) {
    return { group: g, warning: `Group ${g.name}: couldn't read access list "${link.name}", using members from ${link.synced_at ?? "the last sync"}: ${(err as Error).message}` };
  }
}
