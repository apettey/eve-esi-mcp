---
name: live-testing-eve-esi
description: How to exercise the eve-esi-mcp server against live ESI and a real logged-in EVE character safely — the smoke-test harness, which data directory to use, avoiding SSO refresh-token races, and how to test write tools without leaving anything behind. Use this whenever you need to verify a change to eve-esi-mcp end to end, reproduce a bug a user saw with their character, smoke-test after merging, or check a new tool's real output, even if the user only says "test it" or "try it on my character".
---

# Live-testing eve-esi-mcp

Unit tests (the `testing-eve-esi` skill) cover tool output against faked ESI responses. Real ESI data finds the
rest: T3 subsystem counts, ESI list caching after writes, assets in asset safety, 236-fit accounts, Windows file
locking. Live testing is part of shipping any change to tool output, and comes after `npm test` passes.

When a live run turns up a bug, copy the real ESI response shape (trimmed, ids anonymised) into `FakeEsi` routes in
a unit test that fails, then fix it. That way the bug can't come back unnoticed.

## The harness

`scripts/smoke.mjs` runs the built server over stdio like a real MCP client:

```bash
npm run build
node scripts/smoke.mjs --list '[["system_info",{"system":"Jita"}],["search_items",{"queries":["dc ii","mwd"]}]]'
node scripts/smoke.mjs --home C:/Users/apett/.eve-esi-mcp --max 0 --calls calls.json   # full output, calls from a file
node scripts/smoke.mjs --json '[...]'   # one JSON line per call, for scripting or assertions
```

It passes your environment through to the server, so set `EVE_CLIENT_ID` for authenticated tools and
`EVE_FIT_COMMAND=off` to skip eve-fit when you don't need engine stats. It exits non-zero if any call errored. On a
fresh data directory the first call waits for the SDE download and index (about 100 MB, usually under a minute).

## Pick the right data directory

| Situation | `--home` |
| --- | --- |
| Public tools only (items, market, universe, routes) | a fresh scratch folder, or a copy of just `sde-current.json` from the real home (it points at the existing read-only index) |
| Testing an SDE schema change | a fresh scratch folder, so the rebuild doesn't touch the user's install |
| Character tools | the user's real home, `~/.eve-esi-mcp` (on this machine `C:/Users/apett/.eve-esi-mcp`) with `EVE_CLIENT_ID` set |

### Refresh tokens rotate, so one process at a time

EVE SSO issues a new refresh token on every refresh and invalidates the old one. Two server processes refreshing the
same character at the same moment can leave `characters.json` holding a dead token, and the user then has to log in
again. So:

- Only one session or agent uses the real home at a time. If you delegate testing, say which agent owns the
  character, and give everyone else a scratch home.
- Run calls sequentially in one harness invocation rather than many parallel harness processes.
- The user's own Claude sessions may be running the server too. That's usually fine, since access tokens last
  about 20 minutes, but if you see an `invalid_grant` refresh error, stop and tell the user. Don't retry in a loop.

## Read-only by default

Exercise read tools freely. For write tools (`fitting_save`, `fitting_delete`, `mail_send`, `ui_action`,
`route_plan` with `set_destination`, non-GET `esi_request`):

- Only test them when the user has asked for it, or the change is to that write path.
- Use obviously disposable objects, e.g. a fit named `ZZ <purpose> - delete me`. Verify, then delete, and confirm
  it's gone (`fittings_list` with `filter: "ZZ"`). Never leave test objects in the account.
- Don't send real mail to test `mail_send`. Test the validation path (unresolvable recipients fail before sending),
  or send to the user's own alt only if they say so.
- `ui_action` needs the character online in the game client. Check `character_overview` with
  `sections: ["identity"]`. If they're offline, skip it and say so.

## What to look at

Don't just check that a call didn't error. Read the output the way the model will:

- Any bare ids without names? Any `Unknown type`/`Location <id>` that should have resolved?
- Units and rounding sensible (ISK, time left, security as shown in game)?
- Big accounts: is output bounded, with total vs shown and a truncation hint?
- Edge cases from the user's real data: wormhole space, asset safety, capsules, T3 subsystems, empty weapons,
  structures without docking access, alpha-limited skills.
- With eve-fit available, does `stats` agree with the base `resources` within reason, and does it name the pilot used?

## Reporting

In the PR or summary, list what was run live (tool and arguments), what was only unit-tested, and anything skipped
(e.g. "`ui_action` skipped: character offline"). Report numbers you saw rather than "looks good".
