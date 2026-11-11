import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Ctx } from "../context.js";
import { SCOPE_PRESETS } from "../auth/scopes.js";
import type { CharacterGroup, GroupMember } from "../auth/groups.js";
import { findAccessList, listMembers, readAccessLists, syncGroup } from "../access-lists.js";
import { UserError, mapLimit, norm } from "../util.js";
import { READ_ONLY, handler, reply } from "./helpers.js";

export function registerCharacterTools(server: McpServer, ctx: Ctx) {
  server.registerTool(
    "characters_list",
    {
      title: "List logged-in characters",
      description:
        "Lists every EVE character authorized with this server, which one is active (used by default by all character tools), " +
        "their corporation/alliance, character groups (see character_groups) and granted scopes. Call this first when the user refers to a character by name.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    handler(async () => {
      ctx.store.reload();
      const chars = ctx.store.list();
      const affiliations = chars.length
        ? await ctx.esi.post<Array<{ character_id: number; corporation_id: number; alliance_id?: number }>>(
            "/characters/affiliation", chars.map((c) => c.id),
          ).catch(() => [])
        : [];
      const names = await ctx.resolver.entities(affiliations.flatMap((a) => [a.corporation_id, a.alliance_id ?? 0]));
      const active = ctx.store.activeId;
      const groupsOf = new Map<number, string[]>();
      for (const g of ctx.groups.list()) for (const m of g.members) groupsOf.set(m.id, [...(groupsOf.get(m.id) ?? []), g.name]);
      return reply({
        sso_configured: ctx.sso.configured,
        active_character: chars.find((c) => c.id === active)?.name ?? null,
        characters: chars.map((c) => {
          const a = affiliations.find((x) => x.character_id === c.id);
          return {
            name: c.name,
            id: c.id,
            active: c.id === active,
            corporation: a ? names.get(a.corporation_id)?.name : undefined,
            alliance: a?.alliance_id ? names.get(a.alliance_id)?.name : undefined,
            groups: groupsOf.get(c.id),
            scope_count: c.scopes.length,
            scopes: c.scopes.map((s) => s.replace(/^esi-/, "").replace(/\.v1$/, "")),
            token_problem: c.last_refresh_error,
          };
        }),
        hint: chars.length ? undefined : "No characters yet. Call character_login to add one.",
      });
    }),
  );

  server.registerTool(
    "character_login",
    {
      title: "Authorize an EVE character",
      description:
        "Starts EVE SSO login. Opens the user's browser (and returns the URL) so they can pick a character and approve scopes; " +
        "waits for completion up to wait_seconds. Use again to add more characters or to re-authorize with more scopes. " +
        "Scope presets: 'standard' (default: personal data read + fittings/mail/waypoint write), 'readonly', 'full' (adds corporation scopes).",
      inputSchema: {
        scopes: z
          .union([z.enum(["standard", "readonly", "full"]), z.array(z.string())])
          .optional()
          .describe("Preset name or explicit list of ESI scopes."),
        wait_seconds: z.number().int().min(0).max(300).optional().describe("How long to wait for the user to finish (default 120)."),
      },
      annotations: { openWorldHint: true },
    },
    handler(async ({ scopes, wait_seconds }) => {
      const list = Array.isArray(scopes) ? scopes : SCOPE_PRESETS[scopes ?? ""] ?? ctx.cfg.defaultScopes ?? SCOPE_PRESETS.standard;
      const login = await ctx.sso.startLogin(list);
      const opened = ctx.sso.openBrowser(login.url);
      const wait = (wait_seconds ?? 120) * 1000;
      const result = await Promise.race([
        login.promise.then((c) => ({ ok: true as const, c })),
        new Promise<{ ok: false }>((r) => setTimeout(() => r({ ok: false }), wait)),
      ]).catch((err: Error) => {
        throw new UserError(`Login failed: ${err.message}`);
      });
      if (result.ok) {
        return reply({
          status: "authorized",
          character: result.c.name,
          character_id: result.c.id,
          scopes_granted: result.c.scopes.length,
          active: ctx.store.activeId === result.c.id,
          hint: ctx.store.activeId === result.c.id ? undefined : "Use character_select to make this character active.",
        });
      }
      return reply({
        status: "pending",
        browser_opened: opened,
        login_url: login.url,
        message:
          "Ask the user to open the login URL (if the browser did not open), choose a character and authorize. " +
          "The login stays valid for 10 minutes; call characters_list afterwards to confirm.",
      });
    }),
  );

  server.registerTool(
    "character_select",
    {
      title: "Select active character",
      description: "Makes a logged-in character the default for all character tools. Accepts a name (or unique part of it) or id.",
      inputSchema: { character: z.string().describe("Character name or id") },
      annotations: { idempotentHint: true },
    },
    handler(async ({ character }) => {
      const c = ctx.character(character);
      ctx.store.setActive(c.id);
      return reply({ active_character: c.name, character_id: c.id });
    }),
  );

  server.registerTool(
    "character_groups",
    {
      title: "Character groups",
      description:
        "The user's named groups of characters, e.g. 'mains' or 'deployment 1'. A group either follows an in-game access list " +
        "(action 'link': its members are re-read from ESI every time the group is used, so editing the list in game changes the group) " +
        "or is kept by hand ('create', 'add', 'remove'). " +
        "action 'list' (default) shows every group with its members (linked groups refreshed first) plus characters in no group; " +
        "'access_lists' shows the access lists a character manages (needs the esi-access.read_lists.v1 scope); 'sync' refreshes linked groups; " +
        "'rename' and 'delete' work on both kinds. On a linked group, 'remove' excludes a character from the group without touching the access list and 'add' undoes that. " +
        "Tools that take a `characters` list (skill_check, planets, pi_system_planets, pi_optimize, pi_plans, pi_plan_export) accept a group name " +
        "(or \"group:Name\") and expand it to its logged-in members. Nothing here changes the game. Deleting a group: confirm with the user first.",
      inputSchema: {
        action: z.enum(["list", "access_lists", "link", "sync", "create", "add", "remove", "rename", "delete"]).optional().describe("Default 'list'."),
        group: z.string().optional()
          .describe("Group name, e.g. 'mains'. Required for every action but 'list' (where it shows only that group), 'access_lists' and 'sync' (default: every linked group)."),
        access_list: z.string().optional().describe("For 'link': the access list's name (or a unique part of it) or id, e.g. 'Main Toons'."),
        character: z.string().optional()
          .describe("For 'link' and 'access_lists': the character who manages the list and reads it (default: the active character)."),
        characters: z.array(z.string()).max(100).optional()
          .describe("Characters (names, unique parts of names, or ids) to put in the group ('create'/'add') or take out ('remove')."),
        exclude: z.array(z.string()).max(50).optional()
          .describe("For 'link': characters on the access list to leave out of the group, e.g. the main that administers every list."),
        new_name: z.string().optional().describe("New group name for 'rename'."),
        note: z.string().max(200).optional().describe("Optional note on 'create' or 'link'."),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    handler(async ({ action = "list", group, access_list, character, characters, exclude, new_name, note }) => {
      ctx.store.reload();
      const describe = (g: CharacterGroup) => ({
        group: g.name,
        note: g.note,
        follows_access_list: g.access_list ? `${g.access_list.name} (${g.access_list.id}), read by ${g.access_list.via.name}` : undefined,
        last_synced: g.access_list?.synced_at,
        count: g.members.length,
        members: g.members.map((m) => (ctx.store.get(m.id) ? m.name : `${m.name} (not logged in here)`)),
        excluded: g.access_list?.exclude?.map((m) => m.name),
        also_on_the_list: g.access_list?.others,
        updated: g.updated_at,
      });
      const need = (v: string | undefined, what: string) => {
        if (!v?.trim()) throw new UserError(`action '${action}' needs ${what}.`);
        return v;
      };
      const resolve = () => (characters ?? []).map((r) => ctx.character(r));
      /** Matches refs against a member list by id, exact name or unique part of a name. */
      const match = (pool: GroupMember[], refs: string[]) => {
        const hits: GroupMember[] = [];
        const misses: string[] = [];
        for (const ref of refs) {
          const n = norm(ref);
          const exact = pool.filter((m) => String(m.id) === ref.trim() || norm(m.name) === n);
          const found = exact.length ? exact : pool.filter((m) => norm(m.name).includes(n));
          if (found.length === 1) hits.push(found[0]);
          else misses.push(`${ref} (${found.length ? "ambiguous" : "not in the group"})`);
        }
        return { hits, misses };
      };
      const syncAll = async (groups: CharacterGroup[]) => {
        const warnings: string[] = [];
        const out: CharacterGroup[] = [];
        for (const g of groups) {
          const r = await syncGroup(ctx, g);
          out.push(r.group);
          if (r.warning) warnings.push(r.warning);
        }
        return { groups: out, warnings };
      };

      if (action === "list") {
        if (group) {
          const { groups, warnings } = await syncAll([ctx.groups.get(group)]);
          return reply({ ...describe(groups[0]), warnings });
        }
        const { groups, warnings } = await syncAll(ctx.groups.list());
        const grouped = new Set(groups.flatMap((g) => g.members.map((m) => m.id)));
        return reply({
          groups: groups.map(describe),
          not_in_any_group: ctx.store.list().filter((c) => !grouped.has(c.id)).map((c) => c.name),
          warnings,
          hint: groups.length ? undefined : "No groups yet. Use action 'link' to follow an in-game access list, or 'create' for a group kept by hand.",
        });
      }
      if (action === "access_lists") {
        const c = ctx.character(character);
        const lists = await readAccessLists(ctx, c);
        const linked = new Map(ctx.groups.list().filter((g) => g.access_list).map((g) => [g.access_list!.id, g.name]));
        return reply({
          character: c.name,
          access_lists: await mapLimit(lists, 4, async (l) => {
            const { members, others } = await listMembers(ctx, l);
            const access = new Map((l.membership.characters ?? []).map((x) => [x.character_id, x.access]));
            return {
              name: l.name,
              id: l.id,
              description: l.description || undefined,
              group: linked.get(l.id),
              characters: members.map((m) => `${m.name} (${access.get(m.id)})`),
              others,
            };
          }),
          note: "ESI only shows lists this character is a Manager or Admin of. Use action 'link' to make a group follow one.",
        });
      }
      if (action === "link") {
        const name = need(group, "a group name");
        const via = ctx.character(character);
        const l = await findAccessList(ctx, via, need(access_list, "access_list"));
        const all = await listMembers(ctx, l);
        const ex = match(all.members, exclude ?? []);
        if (ex.misses.length) {
          throw new UserError(`Can't exclude ${ex.misses.map((m) => m.replace(/ \(.*\)$/, "")).join(", ")}: not on ${l.name}. On it: ${all.members.map((m) => m.name).join(", ")}.`);
        }
        const other = ctx.groups.list().find((g) => g.access_list?.id === l.id && norm(g.name) !== norm(name));
        if (!ctx.groups.find(name)) ctx.groups.create(name, note);
        ctx.groups.update(name, (g) => {
          g.access_list = { id: l.id, name: l.name, via: { id: via.id, name: via.name }, exclude: ex.hits.length ? ex.hits : undefined };
          if (note) g.note = note;
        });
        const { group: g, warning } = await syncGroup(ctx, ctx.groups.get(name));
        return reply({
          linked: describe(g),
          warnings: [warning, other ? `Group ${other.name} follows the same access list.` : undefined].filter(Boolean),
        });
      }
      if (action === "sync") {
        const targets = group ? [ctx.groups.get(group)] : ctx.groups.list().filter((g) => g.access_list);
        if (!targets.length) throw new UserError("No group follows an access list. Use action 'link' first.");
        const { groups, warnings } = await syncAll(targets);
        return reply({ synced: groups.filter((g) => g.access_list).map(describe), warnings });
      }
      if (action === "create") {
        const members = resolve();
        ctx.groups.create(need(group, "a group name"), note);
        const g = ctx.groups.update(group!, (x) => { x.members = members.map((c) => ({ id: c.id, name: c.name })); });
        return reply({ created: describe(g) });
      }
      if (action === "add" || action === "remove") {
        need(group, "a group name");
        if (!characters?.length) throw new UserError(`action '${action}' needs characters.`);
        const before = ctx.groups.get(group!);
        const changed: string[] = [];
        const unchanged: string[] = [];
        const link = before.access_list;
        if (link) {
          // A linked group's members come from the access list; add/remove only change who is left out.
          let excluded = link.exclude ?? [];
          if (action === "remove") {
            const { hits, misses } = match(before.members, characters);
            unchanged.push(...misses);
            excluded = [...excluded, ...hits];
            changed.push(...hits.map((m) => m.name));
          } else {
            const { hits, misses } = match(excluded, characters);
            unchanged.push(...misses.map((m) => m.replace("not in the group", `not excluded; to add a character, add them to ${link.name} in game`)));
            excluded = excluded.filter((m) => !hits.includes(m));
            changed.push(...hits.map((m) => m.name));
          }
          ctx.groups.update(group!, (g) => { g.access_list = { ...link, exclude: excluded.length ? excluded : undefined }; });
          await syncGroup(ctx, ctx.groups.get(group!));
        } else if (action === "add") {
          const cs = resolve();
          ctx.groups.update(group!, (g) => {
            for (const c of cs) {
              if (g.members.some((m) => m.id === c.id)) unchanged.push(`${c.name} (already in it)`);
              else { g.members.push({ id: c.id, name: c.name }); changed.push(c.name); }
            }
          });
        } else {
          // Members may have logged out, so match the group's own member list (names or ids).
          const { hits, misses } = match(before.members, characters);
          unchanged.push(...misses);
          const gone = new Set(hits.map((m) => m.id));
          ctx.groups.update(group!, (g) => { g.members = g.members.filter((m) => !gone.has(m.id)); });
          changed.push(...hits.map((m) => m.name));
        }
        return reply({
          group: before.name,
          [action === "add" ? "added" : "removed"]: changed,
          skipped: unchanged,
          now: describe(ctx.groups.get(group!)),
        });
      }
      if (action === "rename") {
        const old = ctx.groups.get(need(group, "a group name")).name;
        const g = ctx.groups.rename(group!, need(new_name, "new_name"));
        return reply({ renamed: old, to: g.name });
      }
      // delete
      const g = ctx.groups.remove(need(group, "a group name"));
      return reply({ deleted: g.name, had_members: g.members.map((m) => m.name), access_list_untouched: g.access_list?.name });
    }),
  );

  server.registerTool(
    "character_logout",
    {
      title: "Remove a character",
      description: "Revokes the SSO refresh token for a character and removes it from this server. Only do this when the user asks.",
      inputSchema: { character: z.string().describe("Character name or id") },
      annotations: { destructiveHint: true },
    },
    handler(async ({ character }) => {
      const c = ctx.character(character);
      await ctx.sso.revoke(c);
      ctx.store.remove(c.id);
      return reply({ removed: c.name, active_character: ctx.store.activeId ? ctx.store.get(ctx.store.activeId)?.name : null });
    }),
  );
}
