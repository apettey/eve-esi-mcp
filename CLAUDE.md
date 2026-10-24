# eve-esi-mcp

A TypeScript MCP server for EVE Online's ESI API, built for language models: one call answers one question, every
id comes back with a name, and values use the game's units. See the README for setup and the tool list.

## Before changing tools

- Adding or changing a tool, wrapping a new ESI route, or adding SDE data: follow the `adding-eve-tools` skill
  (`.claude/skills/adding-eve-tools/`). It explains the design principles and has code recipes.
- Verifying a change against live ESI or the user's character: follow the `live-testing-eve-esi` skill. In short:
  `node scripts/smoke.mjs`, one process per character at a time (SSO refresh tokens rotate), read-only unless asked,
  and clean up any test objects.
- Known gaps and planned work: `docs/ROADMAP.md`. Update it when you ship or defer something.

## Commands

```bash
npm run build                       # tsc -> dist/
npm test                            # node:test; SDE-backed tests skip without a local index
node scripts/smoke.mjs '<calls>'    # drive the built server over stdio
node dist/index.js sde-update       # refresh the local static data index
```

## Conventions

- ESI goes through `ctx.esi` only (compatibility date, caching, paging, backoff). Static data comes from the local SDE
  index, not ESI.
- Write tools are annotated, say "confirm with the user" in their description, and are never side effects of reads.
- Bump `SDE_SCHEMA_VERSION` whenever the index schema changes; installs rebuild automatically.
- eve-fit-mcp (Pyfa) provides exact fit stats via its `evaluate_fit` contract (`eve-fit/evaluate_fit@1`). eve-esi
  owns all ESI tokens and sends skills inline.
