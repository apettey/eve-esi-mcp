# eve-esi-mcp

An [MCP](https://modelcontextprotocol.io) server for EVE Online's [ESI API](https://developers.eveonline.com/docs/services/esi/overview/) that's built for AI assistants rather than just wrapping endpoints.

- **Handles auth.** EVE SSO (OAuth2 + PKCE, no client secret needed) with a local callback, refresh-token rotation and JWT verification.
- **Supports several characters.** Log in as many characters as you like, pick an active one, or pass `character: "Name"` to any tool. Tools also compare characters (`skill_check`).
- **Answers in one call.** Each tool resolves names and combines several ESI requests, so the model rarely has to chain lookups. For example, `fitting_get` returns module names per slot, charges, CPU/PG/calibration usage, ship stats and bonuses, attributes for every module, a skill check with training time, and the fit as **EFT** and **DNA**.
- **Uses local static data.** The official CCP [Static Data Export](https://developers.eveonline.com/static-data) is downloaded once and indexed into SQLite, so fuzzy item search, attributes, skills, blueprints, systems and stations need no ESI calls. It checks for a new SDE daily.
- **Follows CCP's rules.** It sends `X-Compatibility-Date` and a descriptive User-Agent, honours ETag and `Expires` caching, fetches `X-Pages` pages in parallel, and backs off on 420 and 429 responses.

## Tools

| Area | Tools |
| --- | --- |
| Characters | `characters_list`, `character_login`, `character_select`, `character_logout` |
| Character data | `character_overview` (location, ship, wallet, SP and training, clones, implants, fatigue, LP), `character_skills`, `skill_check` |
| Assets | `assets` (summary / search / ships), `ship_fitting` (EFT of a real ship; defaults to the one being flown) |
| Fittings | `fittings_list`, `fitting_get`, `fitting_analyze` (any EFT), `fitting_save`, `fitting_delete` |
| Items & universe | `search_items`, `item_info`, `lookup`, `system_info`, `route_plan`, `server_status` |
| Market & money | `market_prices`, `appraise`, `market_orders` (with undercut detection), `wallet`, `contracts` |
| Industry | `industry` (jobs and blueprints), `planets` (PI extractor timers, storage) |
| Comms | `mail_list`, `mail_read`, `mail_send`, `notifications`, `killmails` (fits of losses as EFT) |
| Game client | `ui_action` (set destination, add waypoint, open market or info windows) |
| Anything else | `esi_request` (any ESI route; handles auth and paging, and adds `*_name` fields next to IDs) |

### Example: `fitting_get`

```jsonc
{
  "name": "Brawler",
  "ship": { "name": "Rifter", "stats": { "CPU Output": "130 tf", "Turret Hardpoints": "3 hardpoints", ... },
            "bonuses": { "Minmatar Frigate (per level)": ["7.5% bonus to Small Projectile Turret rate of fire", ...] } },
  "slots": { "high": [{ "slot": "high:0", "module": "200mm AutoCannon II", "charge": "Republic Fleet EMP S" }, ...],
             "low":  [..., { "slot": "low:3", "module": "(empty)" }] },
  "resources": { "cpu": { "used": "116 tf", "available": "130 tf", "percent": 89.2 }, "turret_hardpoints": "3/3", ... },
  "modules": [{ "name": "Stasis Webifier II", "required_skills": [{ "skill": "Propulsion Jamming", "level": 4, "met": true }],
                "attributes": { "EW - Webbing": { "Maximum Velocity Bonus": "-60%" }, "Turrets": { "Optimal Range": "10,000 m" } } }],
  "skill_check": { "character": "My Pilot", "can_use": false, "missing": [{ "skill": "Small Projectile Turret", "required_level": 5, "trained_level": 4, "training_time": "4d 2h" }] },
  "eft": "[Rifter, Brawler]\nDamage Control II\n...",
  "dna": "587:2889;3:..."
}
```

The EFT text is also returned as a separate text block, so it can be copied straight into the game ("Import from Clipboard") or into a fitting engine such as Pyfa.

## Setup

### 1. Register an EVE application

1. Go to <https://developers.eveonline.com/applications> and create an application.
2. Set the **Callback URL** to `http://localhost:8642/callback`.
3. Under **Scopes**, add the scopes you want to allow. The default `standard` preset needs the scopes in [`src/auth/scopes.ts`](src/auth/scopes.ts). Enable more if you plan to log in with the `full` preset (which adds corporation scopes).
4. Copy the **Client ID**. You don't need the secret, because the server uses PKCE.

### 2. Install

```bash
git clone https://github.com/apettey/eve-esi-mcp.git
cd eve-esi-mcp
npm install
npm run build
```

Requires Node.js 22.13 or later (it uses the built-in `node:sqlite`).

### 3. Add it to your MCP client

Claude Code:

```bash
claude mcp add eve-esi -e EVE_CLIENT_ID=your_client_id -e EVE_CONTACT=you@example.com -- node /path/to/eve-esi-mcp/dist/index.js
```

Claude Desktop (`claude_desktop_config.json`) or any other stdio MCP client:

```json
{
  "mcpServers": {
    "eve-esi": {
      "command": "node",
      "args": ["/path/to/eve-esi-mcp/dist/index.js"],
      "env": {
        "EVE_CLIENT_ID": "your_client_id",
        "EVE_CONTACT": "you@example.com"
      }
    }
  }
}
```

On first start the server downloads and indexes the static data (about 100 MB, usually under a minute). Public tools such as item search and market prices work without logging in.

### 4. Log in a character

Ask your assistant to "log in my EVE character". It calls `character_login`, which opens the EVE login page in your browser. Repeat this for each character. You can also log in from a terminal:

```bash
node dist/index.js login            # standard scopes
node dist/index.js login full       # include corporation scopes
node dist/index.js characters       # list stored characters
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `EVE_CLIENT_ID` | — | Client ID of your EVE application (required for login) |
| `EVE_CLIENT_SECRET` | — | Optional; set it to use the confidential-client flow instead of PKCE |
| `EVE_CALLBACK_URL` | `http://localhost:8642/callback` | Must match the application's callback URL |
| `EVE_ESI_MCP_HOME` | `~/.eve-esi-mcp` | Data directory (characters, SDE index, name cache) |
| `EVE_CONTACT` | — | Email or Discord handle added to the User-Agent, as [CCP asks](https://developers.eveonline.com/docs/services/esi/best-practices/) |
| `EVE_SCOPES` | `standard` preset | Default scopes for `character_login` |
| `EVE_OPEN_BROWSER` | `true` | Set to `false` to only return the login URL |

## Data and security

- Refresh tokens are stored in `characters.json` in the data directory, with owner-only file permissions where the OS supports them. Anyone who can read that file can access the characters' data within the granted scopes. Use `character_logout` to revoke a token.
- `fitting_save`, `fitting_delete`, `mail_send`, `ui_action`, `route_plan` with `set_destination`, and non-GET `esi_request` calls change things in your account or game client. The tool descriptions tell the model to confirm with you first.
- Fitting resource numbers come from static data, so skills, rigs and module bonuses aren't applied. For exact stats, give the EFT output to a fitting engine.

## Development

```bash
npm run build    # compile TypeScript to dist/
npm test         # unit tests (SDE-backed tests run when an SDE index exists)
node dist/index.js sde-update   # force a static data refresh
```

The server targets ESI compatibility date `2026-08-18` (`COMPATIBILITY_DATE` in [`src/config.ts`](src/config.ts)). Check `/meta/changelog` before you bump it.

## License

MIT. EVE Online and all related materials are the intellectual property of CCP hf.
