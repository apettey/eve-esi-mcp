import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "./config.js";
import type { Ctx } from "./context.js";
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

/** Every tool group, registered on a fresh server. Tests build it with a fake Ctx (src/test/harness.ts). */
export function buildServer(ctx: Ctx): McpServer {
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
