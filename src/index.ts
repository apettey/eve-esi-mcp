#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VERSION, loadConfig } from "./config.js";
import { Ctx } from "./context.js";
import { SCOPE_PRESETS } from "./auth/scopes.js";
import { log } from "./util.js";
import { registerCharacterTools } from "./tools/characters.js";
import { registerUniverseTools } from "./tools/universe.js";
import { registerCharacterDataTools } from "./tools/character.js";
import { registerAssetTools } from "./tools/assets.js";
import { registerFittingTools } from "./tools/fittings.js";
import { registerEconomyTools } from "./tools/economy.js";
import { registerIndustryTools } from "./tools/industry.js";
import { registerCommsTools } from "./tools/comms.js";
import { registerRawTools } from "./tools/raw.js";
import { registerDoctrineTools } from "./tools/doctrine.js";

const INSTRUCTIONS = `EVE Online ESI server. Everything comes back with names resolved (items, systems, stations, structures,
characters, corporations), so you rarely need to look ids up yourself.

Characters: several EVE characters can be logged in. Character tools act as the active character unless you pass
\`character\` (name or id). characters_list shows who is available; character_select changes the default;
character_login adds/re-authorizes a character (opens the browser for EVE SSO).

Prefer the composite tools — they each replace many raw ESI calls:
- character_overview: location, ship, wallet, SP/training, clones/implants, fatigue, LP in one call.
- assets (summary | search | ships) and ship_fitting (EFT of an actual ship, default the one being flown).
- fittings_list / fitting_get / fitting_analyze / fitting_save: fits with module names, slot layout, CPU/PG,
  attributes, skill check and EFT text. With eve-fit-mcp configured they also include engine \`stats\` (EHP/resists, DPS,
  cap, speed, skill-applied CPU/PG) calculated with the character's real skills.
- item_info / search_items / skill_check / market_prices / appraise / route_plan / system_info (incl. wormhole class/effect/statics) / wormhole_type / lookup.
- doctrine_from_killmails / doctrine_from_battle_report: enemy comps (hulls, pilots, loss EFTs, weapons) from zKillboard
  URLs, filters or battle reports, as bundles to pass unchanged to eve-fit's save_doctrine.
- esi_request covers any remaining ESI route.
Static data (items, attributes, systems) is served locally; the first call after install may take ~1 minute while
the official SDE is downloaded and indexed.
Write actions (fitting_save/delete, mail_send, ui_action, route_plan set_destination, non-GET esi_request) affect
the user's account or game client: confirm with the user first.`;

function buildServer(ctx: Ctx): McpServer {
  const server = new McpServer({ name: "eve-esi-mcp", version: VERSION }, { instructions: INSTRUCTIONS });
  registerCharacterTools(server, ctx);
  registerCharacterDataTools(server, ctx);
  registerAssetTools(server, ctx);
  registerFittingTools(server, ctx);
  registerUniverseTools(server, ctx);
  registerEconomyTools(server, ctx);
  registerIndustryTools(server, ctx);
  registerCommsTools(server, ctx);
  registerDoctrineTools(server, ctx);
  registerRawTools(server, ctx);
  return server;
}

async function serve() {
  const ctx = new Ctx(loadConfig());
  const server = buildServer(ctx);
  await server.connect(new StdioServerTransport());
  log(`v${VERSION} ready (data dir ${ctx.cfg.home}${ctx.cfg.clientId ? "" : "; EVE_CLIENT_ID not set — only public tools work"})`);
  // Warm the static data in the background so the first tool call is fast, then check for a newer SDE.
  ctx.sde()
    .then(() => ctx.sdeManager.maybeUpdate())
    .catch((err) => log("Static data not ready:", (err as Error).message));
}

async function cliLogin(preset?: string) {
  const ctx = new Ctx(loadConfig());
  const scopes = SCOPE_PRESETS[preset ?? "standard"] ?? preset!.split(",");
  const login = await ctx.sso.startLogin(scopes);
  console.log(`Open this URL to authorize a character:\n\n${login.url}\n`);
  ctx.sso.openBrowser(login.url);
  const c = await login.promise;
  console.log(`Authorized ${c.name} (${c.id}) with ${c.scopes.length} scopes. Stored in ${ctx.cfg.home}.`);
  process.exit(0);
}

function cliCharacters() {
  const ctx = new Ctx(loadConfig());
  const active = ctx.store.activeId;
  const list = ctx.store.list();
  if (!list.length) console.log("No characters. Run: eve-esi-mcp login");
  for (const c of list) console.log(`${c.id === active ? "*" : " "} ${c.name} (${c.id}) — ${c.scopes.length} scopes`);
}

async function cliSdeUpdate() {
  const ctx = new Ctx(loadConfig());
  await ctx.sde();
  const r = await ctx.sdeManager.maybeUpdate(true);
  console.log(r.updated ? `Updated SDE to build ${r.build}.` : `SDE is current (build ${r.build}).`);
}

const HELP = `eve-esi-mcp ${VERSION}

Usage:
  eve-esi-mcp                 Run the MCP server on stdio (what MCP clients launch)
  eve-esi-mcp login [preset]  Authorize a character from the terminal (preset: standard | readonly | full)
  eve-esi-mcp characters      List stored characters (* = active)
  eve-esi-mcp sde-update      Download/refresh the static data index now

Environment:
  EVE_CLIENT_ID       Client ID of your application at https://developers.eveonline.com/applications (required for SSO)
  EVE_CLIENT_SECRET   Optional; omit to use PKCE
  EVE_CALLBACK_URL    Default http://localhost:8642/callback (must match the application)
  EVE_ESI_MCP_HOME    Data directory (default ~/.eve-esi-mcp)
  EVE_CONTACT         Contact (email/discord) added to the ESI User-Agent, as CCP requests
  EVE_SCOPES          Default scopes for login (space/comma separated)
  EVE_OPEN_BROWSER    Set to "false" to never open a browser automatically
  EVE_FIT_DIR         eve-fit-mcp checkout (with .venv) for engine-accurate fit stats; default ../eve-fit-mcp if present
  EVE_FIT_COMMAND     Command to start eve-fit over stdio instead (EVE_FIT_ARGS, EVE_FIT_CWD); "off" disables it
`;

const [cmd, arg] = process.argv.slice(2);
const run =
  cmd === undefined || cmd === "serve" ? serve
  : cmd === "login" ? () => cliLogin(arg)
  : cmd === "characters" ? async () => cliCharacters()
  : cmd === "sde-update" ? cliSdeUpdate
  : async () => { console.log(HELP); };

run().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
