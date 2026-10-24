import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Ctx } from "../context.js";
import { SCOPE_PRESETS } from "../auth/scopes.js";
import { UserError } from "../util.js";
import { READ_ONLY, handler, reply } from "./helpers.js";

export function registerCharacterTools(server: McpServer, ctx: Ctx) {
  server.registerTool(
    "characters_list",
    {
      title: "List logged-in characters",
      description:
        "Lists every EVE character authorized with this server, which one is active (used by default by all character tools), " +
        "their corporation/alliance and granted scopes. Call this first when the user refers to a character by name.",
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
