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
| Character data | `character_overview` (location, ship, wallet, SP and training, alpha/omega, clones, implants, fatigue, LP), `character_skills`, `skill_check` |
| Assets | `assets` (summary / search / ships), `ship_fitting` (EFT of a real ship; defaults to the one being flown) |
| Fittings | `fittings_list`, `fitting_get`, `fitting_analyze` (any EFT), `fitting_save`, `fitting_delete` |
| Items & universe | `search_items`, `item_info`, `lookup`, `system_info` (includes wormhole class, effect and statics), `wormhole_type` (K162, H296, ...), `route_plan`, `server_status` |
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
  "stats": { "pilot": "custom skills", "skills_used": "My Pilot's trained skills (active levels) with 3 active implant(s).",   // with eve-fit only
             "offense": { "dps": 142.3, "volley": 213.5, ... }, "defense": { "ehp": 4120, "resists_percent": { ... } },
             "capacitor": { "stable": false, "lasts_s": 95 }, "navigation": { "max_speed_m_s": 3240.5, "align_time_s": 4.69 },
             "fitting": { "cpu_tf": { "used": 135.8, "total": 162.5, "percent": 83.5 }, ... } },
  "modules": [{ "name": "Stasis Webifier II", "required_skills": [{ "skill": "Propulsion Jamming", "level": 4, "met": true }],
                "attributes": { "EW - Webbing": { "Maximum Velocity Bonus": "-60%" }, "Turrets": { "Optimal Range": "10,000 m" } } }],
  "skill_check": { "character": "My Pilot", "can_use": false, "missing": [{ "skill": "Small Projectile Turret", "required_level": 5, "trained_level": 4, "training_time": "4d 2h" }] },
  "eft": "[Rifter, Brawler]\nDamage Control II\n...",
  "dna": "587:2889;3:..."
}
```

The EFT text is also returned as a separate text block, so it can be copied straight into the game ("Import from Clipboard") or into a fitting engine such as Pyfa.

### Accurate fit stats with eve-fit

`resources` uses static data only, so skills, rigs and module bonuses aren't applied, and many working fits look over budget there. For engine-accurate numbers, `fitting_get`, `ship_fitting` and `fitting_analyze` can use [eve-fit-mcp](https://github.com/apettey/eve-fit-mcp), a fitting engine built on Pyfa. When eve-fit is configured, each fit also gets a `stats` section with these values:

- offense: DPS and volley (weapons and drones), range and tracking of the main weapon, missile explosion radius and velocity, and a per-weapon-group breakdown
- defense: EHP per layer and against each single damage type, resists, sustained and burst tank
- capacitor: stability, or how long it lasts
- navigation: speed, align time, signature and warp speed, plus the same values with the prop module off when they differ
- targeting: lock range, scan resolution and sensor strength
- fitting: CPU/PG/calibration/drone/cargo usage after skills, plus slot and hardpoint usage
- any fitting issues and missing skills

eve-esi-mcp starts eve-fit as a child MCP server the first time a fitting tool needs it, then reuses it. Each fit is a single stateless `evaluate_fit` call (contract `eve-fit/evaluate_fit@1`). If a character with the skills scope is involved, its active skill levels are sent with the call, along with its active implants if the token has `esi-clones.read_implants.v1` and the fit lists no implants of its own. So the stats reflect what that character can actually fly. With no character, the stats use `All 5`. The `pilot` and `skills_used` fields say which skills were used. If eve-fit isn't configured, is too old to have `evaluate_fit`, or fails, `stats` is left out and a short `stats_note` explains why. The rest of the output is unaffected.

In-game saved fittings keep ammo in cargo, and ships in assets often have empty guns, so on its own the engine would report 0 weapon DPS for most real fits. To avoid that, every turret and launcher without a charge is loaded, for the engine's calculation only, with a compatible charge from the fit's cargo. A charge is compatible when its charge group matches and, for turrets, its size matches. The largest stack wins. For `ship_fitting`, the ship's real cargo hold is used even with `include_cargo: false`. `stats.assumed_charges` lists what was loaded (e.g. `200mm AutoCannon II x3: Republic Fleet EMP S (from cargo)`), and `stats.unloaded_weapons` lists weapons with nothing compatible in cargo. The displayed slots, EFT and DNA still show the fit exactly as it is. Pass `load_cargo_ammo: false` to turn this off.

To enable it, set `EVE_FIT_DIR` to an eve-fit-mcp checkout (commit 03e5b41 or newer) that has a `.venv`, or set `EVE_FIT_COMMAND`/`EVE_FIT_ARGS` to launch it some other way. A checkout named `eve-fit-mcp` next to this package is detected automatically. The very first start builds eve-fit's game data and item index, which takes about 30 s. Later starts take a few seconds, and each fit then takes milliseconds. eve-esi-mcp keeps the only ESI tokens; eve-fit's own ESI login isn't used.

### Wormhole rollers

A fit counts as a roller when its name or description mentions rolling, it has a Higgs Anchor rig, or it carries more than one prop module. `fitting_get`, `ship_fitting` and `fitting_analyze` then add a `rolling` section. It gives the hull mass and the jump mass cold (no prop running) and hot with each prop module, since prop modules add mass only while they run. Plates and Higgs Anchors are included. It also gives roller advice:

- Fit the biggest microwarpdrive. It adds the most mass and is the fastest way back to the hole.
- Back it up with an afterburner of the same size. A warp scrambler shuts the MWD off, but the afterburner still runs and adds the same mass, so you can still jump hot and crush the hole.
- A smaller prop module (e.g. a 500MN MWD on a capital) adds about a tenth of the mass and is flagged as probably not worth the slot.

The masses come from static data, so check them in game or in Pyfa before relying on exact numbers.

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
| `EVE_FIT_DIR` | sibling `../eve-fit-mcp` if present | eve-fit-mcp checkout. Launched as `.venv` Python `-m eve_fit_mcp.server` for [accurate stats](#accurate-fit-stats-with-eve-fit) |
| `EVE_FIT_COMMAND` | — | Command that starts eve-fit over stdio. Overrides `EVE_FIT_DIR`. Set it to `off` to disable the integration |
| `EVE_FIT_ARGS` | — | Arguments for `EVE_FIT_COMMAND`, separated by spaces or given as a JSON array |
| `EVE_FIT_CWD` | — | Working directory for `EVE_FIT_COMMAND` |

## Data and security

- Refresh tokens are stored in `characters.json` in the data directory, with owner-only file permissions where the OS supports them. Anyone who can read that file can access the characters' data within the granted scopes. Use `character_logout` to revoke a token.
- `fitting_save`, `fitting_delete`, `mail_send`, `ui_action`, `route_plan` with `set_destination`, and non-GET `esi_request` calls change things in your account or game client. The tool descriptions tell the model to confirm with you first.
- Wormhole class, system effects with their modifiers, and wormhole type attributes (destination, mass, lifetime) come from the SDE. The SDE doesn't list statics, so these come from [WormholeSystems](https://github.com/WormholeSystems/WormholeSystems) (`data/static/wormhole_systems.json`, MIT licence, © 2026 WormholeSystems), vendored in [`src/sde/wormhole-statics.ts`](src/sde/wormhole-statics.ts). Run `node scripts/update-wormhole-statics.mjs` to refresh it.
- Fitting resource numbers in `resources` come from static data, so skills, rigs and module bonuses aren't applied. For exact stats, configure eve-fit (see above).
- With eve-fit enabled, a character's skill levels and implant type ids are sent to the local eve-fit process for each fit. Nothing is stored there, and no tokens are shared.

## Development

```bash
npm run build    # compile TypeScript to dist/
npm test         # unit tests (SDE-backed tests run when an SDE index exists)
node scripts/smoke.mjs '[["system_info",{"system":"Jita"}]]'   # call tools on the built server over stdio
node dist/index.js sde-update   # force a static data refresh
```

When working on this repo with Claude Code, [`CLAUDE.md`](CLAUDE.md) and the project skills in
[`.claude/skills/`](.claude/skills/) describe how tools should be designed (`adding-eve-tools`) and safely tested
against a live character (`live-testing-eve-esi`).

The server targets ESI compatibility date `2026-08-18` (`COMPATIBILITY_DATE` in [`src/config.ts`](src/config.ts)). Check `/meta/changelog` before you bump it.

## License

MIT. EVE Online and all related materials are the intellectual property of CCP hf.
