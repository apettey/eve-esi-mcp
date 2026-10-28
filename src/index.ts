#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VERSION, loadConfig } from "./config.js";
import { Ctx } from "./context.js";
import { SCOPE_PRESETS } from "./auth/scopes.js";
import { log } from "./util.js";
import { buildServer } from "./server.js";

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
