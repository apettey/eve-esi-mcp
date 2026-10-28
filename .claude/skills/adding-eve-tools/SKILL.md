---
name: adding-eve-tools
description: How to design and build tools for the eve-esi-mcp server so they stay model-friendly — names instead of ids, one call instead of many, formatted units, multi-character support, graceful partial results. Use this whenever you add a new MCP tool to eve-esi-mcp, extend or change an existing tool's inputs or output, wrap a new ESI route, add data from the SDE, or review a PR that touches src/tools/. Also use it when the user asks for "a tool that…", "support for <ESI feature>", or "make X available to the AI" in this repo, even if they don't say "tool".
---

# Adding tools to eve-esi-mcp

This server exists because raw ESI is hostile to language models: it returns bare ids, splits one question across a
dozen routes, and leaves units and pagination to the caller. Every model round-trip costs latency, tokens and a chance
to get lost. The tools here are designed so the model asks one question and gets an answer it can act on.

Keep that spirit with every change. A tool that "works" but returns `type_id: 2048` and makes the model call
`item_info` to learn it's a Damage Control II is a regression, even if it's technically correct.

## The principles (and why)

1. **Answer the question, don't wrap the endpoint.** Before writing code, write down the question a player would ask
   ("what's my wallet doing?", "is this fit flyable?") and what the model will want to do *next* with the answer. Fold
   those follow-up lookups into the tool. `character_overview` replaces ~12 ESI calls; `fitting_get` returns slots,
   resources, attributes, skill check and EFT so the model never has to chain `item_info` per module.

2. **Names, never bare ids.** Every id in output gets resolved: types, systems, stations, structures, characters,
   corporations, alliances, factions. Static things come from the local SDE (free, instant); players and corps from
   `ctx.resolver` (cached). Check the payload first: some routes already include names (corp structures, mail
   labels), so don't resolve those again. Keep an id next to the name only when the model needs it for a
   follow-up call (`fitting_id`, `item_id`, `type_id`, `mail_id`, `contract_id`).

3. **Human units, raw numbers only where math happens.** Use `isk()`, `duration()`, `sde.formatAttribute()` so values
   read like the game ("623.09m ISK", "4d 2h", "40 tf", "12.5%"). Add a raw field alongside only when the model will
   plausibly compute with it (`balance_raw`, order book prices). Translate enum codes into what they mean
   (`armor_reinforce` → "armor reinforced (timer running)"). When a missing field carries meaning, say so explicitly
   (a structure with no `fuel_expires` is in low power), because the model can't see what isn't there.

4. **Batch inputs.** If someone might ask about several things, accept an array (`items`, `queries`, `codes`,
   `fittings`) with a sensible `.max()`. Use `mapLimit` for concurrent ESI calls (4–8 is plenty).

5. **Any character, explicitly.** Tools acting for a character take `character: characterParam`, resolve with
   `ctx.character(ref)` (required) or `ctx.maybeCharacter(ref)` (optional enrichment, e.g. a skill check), and echo
   `character: c.name` in the output so it's never ambiguous whose data this is.

6. **Partial beats failed.** Composite tools run each part through `section(errors, "name", fn)` and report missing
   parts under `unavailable`/`errors`. A missing scope for loyalty points must not hide the wallet.

7. **Actionable errors.** Throw `UserError` with the next step in the message ("…call `character_login` with the
   `full` preset", "ambiguous: did you mean A, B, C?"). Pass `scope:` to ESI calls: a missing scope then produces a
   message naming the preset that contains it. Missing in-game *roles* (corporation routes) aren't covered by that,
   so handle them as shown under "Corporation routes" in the patterns reference.

8. **Compact, bounded output.** `reply()` already drops nulls/empty arrays. Add a `limit` with a default, return
   `total` vs shown and a hint when truncated, and prefer summaries + totals over dumping thousands of rows. Long
   lists of short items read best as strings (`"Jita (0.9) [The Forge] {45 kills/h}"`), not objects.

9. **Copyable artefacts as their own text block.** EFT, mail bodies and similar go in `reply(data, { texts: [...] })`
   too, so the model can pass them on verbatim without JSON escaping.

10. **Writes are explicit and honest.** Anything that changes the account or the game client gets
    `annotations: { openWorldHint: true }` (plus `destructiveHint: true` if it deletes), says "confirm with the user
    first" in its description, and never happens as a side effect of a read tool. ESI caches lists for minutes, so
    after a write, make the server's own view consistent (see the pending-writes pattern in `src/tools/fittings.ts`).

11. **Be a good ESI citizen.** All HTTP goes through `ctx.esi` (compatibility date, User-Agent, ETag/Expires cache,
    X-Pages fan-out, 420/429 backoff). Never `fetch` ESI directly, and never poll faster than `Expires`. Static data
    (types, attributes, systems, blueprints) comes from the SDE, not `/universe/types`.

12. **Descriptions sell the tool.** The model chooses tools from their descriptions. Lead with what question it
    answers, list what comes back, name the related tools ("Use item_info for full details"). Parameter
    `.describe()` strings should give an example value.

## Workflow

1. **Sketch first.** Write the question, the inputs (with defaults) and a short example of the output JSON. Show the
   sketch to the user when the shape is a judgement call, for example whether to fold a feature into an existing
   tool or make a new one, whether the tool writes anything, which defaults decide what most answers look like
   (Jita vs region-wide prices), or anything that needs a scope outside the standard preset. This takes two minutes
   and prevents most redesigns.
2. **Extend before adding.** Check `src/tools/*.ts` (and the tool list in `INSTRUCTIONS` in `src/server.ts`). A new
   `include`/`mode` option on an existing tool often beats a new tool: every tool adds to the model's context and
   to the choice it has to make. Add a new tool when the question is genuinely different. If it belongs to no
   existing area (e.g. the first corporation tool), create `src/tools/<area>.ts` exporting
   `register<Area>Tools(server, ctx)` and call it from `buildServer` in `src/server.ts`.
3. **Find the data.** ESI: read the route in the live spec. The patterns reference has a snippet that prints a
   route's parameters, response shape, scope, required roles, rate-limit group and compatibility date. If the route's
   `x-compatibility-date` is newer than `COMPATIBILITY_DATE` in `src/config.ts`, review `/meta/changelog` before
   bumping it. Static data: check whether the SDE index already has it (`src/sde/db.ts`); if not, extend
   `src/sde/build.ts` and bump `SDE_SCHEMA_VERSION`.
4. **Implement with a test** in the matching `src/tools/<area>.ts` using the recipes in
   [references/patterns.md](references/patterns.md) — read it before writing the handler. Register new tool groups in
   `buildServer` (`src/server.ts`) and mention new tools in `INSTRUCTIONS` there if they change how the model should
   approach things. Write the handler test in `src/test/tools-<area>.test.ts` as soon as the handler returns
   something (follow the `testing-eve-esi` skill): `callTool` with a fake ESI shows you the exact output the model
   will get, long before a live run. `npm test` fails for a registered tool without a test, so this isn't optional.
5. **Scopes.** First check whether the scope is already in a preset in `src/auth/scopes.ts`. If not, add it:
   `STANDARD_SCOPES` for personal data most players want; `FULL_SCOPES` for corporation/alliance scopes and anything
   that needs in-game roles. Mention it in the README's app-registration note. Existing logins won't have it until
   they log in again, so the tool must fail with the actionable scope error, not a crash.
6. **Test.** Cover the failure paths too (missing scope, unknown name, an ESI error in one section) and any pure
   logic you added (parsers, formatters, matching); `npm test` builds and runs everything. Then drive it live with
   the `live-testing-eve-esi` skill — real ESI data finds the bugs unit tests don't (we found T3 subsystem counts,
   stale caches and a Windows rename bug that way). When live testing finds a bug, add a unit test reproducing it
   before fixing it.
7. **Document.** Add the tool to the README tools table; remove anything it completes from `docs/ROADMAP.md`, and
   add any known gap you're leaving behind.
8. **Ship.** Commit code and tests together on a branch and open a PR listing what is unit-tested, what was tested
   live, and what wasn't. CI runs `npm test` with a fresh SDE index on every PR.

## Before you call it done

- [ ] Every id in the output has a name next to it (or is an id the model needs for a follow-up call)
- [ ] Values have units and are formatted; raw numbers only where math is likely
- [ ] Works for a non-active character via `character`; output says which character
- [ ] Missing scope / no character / unknown name each produce a clear, actionable message
- [ ] Composite parts fail independently (`section`)
- [ ] Output is bounded (limit, total, truncation hint) on a large account (thousands of assets, hundreds of fits)
- [ ] Write tools: annotations set, description says to confirm, live-tested with a throwaway object that was cleaned up
- [ ] Description leads with the question it answers and names related tools
- [ ] Handler test in `src/test/tools-<area>.test.ts` covering the happy path and the likely failure; tool not added
      to `UNTESTED` (and removed from it if you touched a listed tool)
- [ ] `npm test` passes with no new skips; live-tested; README and ROADMAP updated
