import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Ctx } from "../context.js";
import { SCOPE_PRESETS } from "../auth/scopes.js";
import type { CharacterGroup } from "../auth/groups.js";
import { UserError, norm } from "../util.js";
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
        "The user's own groups of logged-in characters (e.g. mirroring in-game access lists, which ESI cannot read), stored locally by this server. " +
        "action 'list' (default) shows every group with its members, plus characters in no group; 'create', 'add', 'remove', 'rename' and 'delete' edit them. " +
        "Tools that take a `characters` list (skill_check, planets, pi_system_planets, pi_optimize, pi_plans) accept a group name there " +
        "(or \"group:Name\") and expand it to its members. Groups are not synced with the game: when the user changes an access list in game, update the group. " +
        "Deleting a group: confirm with the user first.",
      inputSchema: {
        action: z.enum(["list", "create", "add", "remove", "rename", "delete"]).optional().describe("Default 'list'."),
        group: z.string().optional().describe("Group name, e.g. 'Hauler alts'. Required for every action but 'list' (where it shows only that group)."),
        characters: z.array(z.string()).max(100).optional()
          .describe("Characters (names, unique parts of names, or ids) to put in the group ('create'/'add') or take out ('remove')."),
        new_name: z.string().optional().describe("New group name for 'rename'."),
        note: z.string().max(200).optional().describe("Optional note on 'create', e.g. 'mirrors the Home POS access list'."),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    handler(async ({ action = "list", group, characters, new_name, note }) => {
      ctx.store.reload();
      const describe = (g: CharacterGroup) => ({
        group: g.name,
        note: g.note,
        count: g.members.length,
        members: g.members.map((m) => (ctx.store.get(m.id) ? m.name : `${m.name} (not logged in)`)),
        updated: g.updated_at,
      });
      const need = (v: string | undefined, what: string) => {
        if (!v?.trim()) throw new UserError(`action '${action}' needs ${what}.`);
        return v;
      };
      const resolve = () => (characters ?? []).map((r) => ctx.character(r));

      if (action === "list") {
        if (group) return reply(describe(ctx.groups.get(group)));
        const groups = ctx.groups.list();
        const grouped = new Set(groups.flatMap((g) => g.members.map((m) => m.id)));
        return reply({
          groups: groups.map(describe),
          not_in_any_group: ctx.store.list().filter((c) => !grouped.has(c.id)).map((c) => c.name),
          hint: groups.length ? undefined : "No groups yet. Use action 'create' with a group name and characters.",
        });
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
        if (action === "add") {
          const cs = resolve();
          ctx.groups.update(group!, (g) => {
            for (const c of cs) {
              if (g.members.some((m) => m.id === c.id)) unchanged.push(`${c.name} (already in it)`);
              else { g.members.push({ id: c.id, name: c.name }); changed.push(c.name); }
            }
          });
        } else {
          // Members may have logged out, so match the group's own member list (names or ids) as well as logged-in characters.
          ctx.groups.update(group!, (g) => {
            for (const ref of characters) {
              const n = norm(ref);
              const hits = g.members.filter((m) => String(m.id) === ref.trim() || norm(m.name) === n);
              const partial = hits.length ? hits : g.members.filter((m) => norm(m.name).includes(n));
              if (partial.length === 1) {
                g.members = g.members.filter((m) => m !== partial[0]);
                changed.push(partial[0].name);
              } else {
                unchanged.push(`${ref} (${partial.length ? "ambiguous" : "not in the group"})`);
              }
            }
          });
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
      return reply({ deleted: g.name, had_members: g.members.map((m) => m.name) });
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
