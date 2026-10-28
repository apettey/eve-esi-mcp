---
name: testing-eve-esi
description: How to write automated tests for eve-esi-mcp — the in-process MCP harness, the fake ESI and fake context, SDE-backed tests, the tool coverage ratchet and what to assert. Use this whenever you change anything under src/ in eve-esi-mcp (new or changed tool, bug fix, refactor, parser, formatter, ESI client), when a test fails, when the user asks to "add tests", "cover this" or "make sure this doesn't break again", and before opening a PR. Tests ship in the same change as the code, so reach for this skill as soon as you start writing code, not at the end.
---

# Testing eve-esi-mcp

Every change to `src/` ships with tests in the same commit. Agents (and people) building tools here work fast, and
the model-facing output is the product: a tool that silently returns a bare id, loses a name or swallows a scope
error is broken even if it doesn't throw. Tests are how we notice before a user does.

`npm test` builds first (`pretest`), then runs `node --test dist/test/*.test.js`. CI runs the same on every PR with
a freshly built SDE index and fails if any test skips.

## The rules

1. **Tests in the same change.** Write the test alongside the code, not after the PR is open. For a new tool,
   write the test as soon as the handler returns something; it is the fastest way to see the output shape.
2. **Bug fix = regression test first.** Reproduce the bug in a failing test, then fix it. Name the test after the
   behaviour ("assets in asset safety show the system, not Location 0"), not the ticket.
3. **Every tool has a handler test.** `src/test/tools.test.ts` lists all registered tools and fails if one has no
   test that calls it. The `UNTESTED` set there is legacy debt: it may only shrink. Never add a tool to it; when
   you touch a listed tool, add its test and remove it from the list (the ratchet fails until you do).
4. **Assert what the model sees.** Names next to ids, formatted units, `character` echoed, error text that names
   the next step. Assert exact values where the format matters (`"1.23b ISK"`), patterns where wording may evolve.
5. **No network, no real characters.** Unit tests never call ESI, zKillboard, SSO or eve-fit. The fakes below cover
   those. Live checks are the `live-testing-eve-esi` skill, after `npm test` passes.

## Which layer

| What changed | Test with | File |
| --- | --- | --- |
| A tool's inputs, output or errors | `callTool` + `testCtx` (in-process MCP) | `src/test/tools-<area>.test.ts` (mirrors `src/tools/<area>.ts`) |
| Pure logic: parsers, formatters, matching, fit model | direct calls | the module's test file, e.g. `doctrine.test.ts`, `core.test.ts` |
| ESI client: caching, paging, retries, errors | stubbed `globalThis.fetch` | `esi-client.test.ts` |
| Store, `reply`/`handler`/`section`, util, scopes | direct calls | `infra.test.ts` |
| eve-fit integration | `FakeEngine` | `evefit.test.ts`, `ammo.test.ts` |
| Annotations, descriptions, write-tool wording | automatic for every tool | `tools.test.ts` |

## The harness (`src/test/harness.ts`)

```ts
import { callTool, character, esiError, sde, testCtx, withSde } from "./harness.js";

const PILOT = character(90000101, "Wallet Pilot");            // STANDARD_SCOPES by default; pass a list to test scope errors

withSde("wallet names parties and formats ISK", async () => {
  const ctx = testCtx({
    characters: [PILOT],                                        // first one is active; real CharacterStore in a temp dir
    esi: {
      [`/characters/${PILOT.id}/wallet`]: 1_234_567_890.5,      // "/path" answers any method
      "POST /universe/names": [{ id: 1000125, name: "CONCORD", category: "corporation" }],
      "/status": () => { throw esiError(503, "down", "/status"); },   // functions get the request; throw to fail
    },
  });
  const r = await callTool(ctx, "wallet", { days: 7 });         // real MCP path: zod input validation, handler(), reply()
  assert.equal(r.isError, false, r.text);                       // always pass r.text so failures show the tool's message
  assert.equal(r.json.balance, "1.23b ISK");                    // r.json = first block parsed; r.texts = extra blocks (EFT)
  assert.equal(ctx.esi.callsTo(`/characters/${PILOT.id}/wallet`)[0].opts.scope, "esi-wallet.read_character_wallet.v1");
});
```

- `testCtx` is a real `Ctx` (store, `Resolver`, character resolution) with `FakeEsi` in place of the HTTP client.
  Replace anything else with `overrides` (`sso`, `zkill`, `sdeManager`), e.g. `{ sso: { configured: true, revoke } }`.
- `FakeEsi` runs the real scope check, so missing-scope messages match production. An unknown route throws
  `FakeEsi: no route for GET /x`; add the route rather than loosening the fake. Arrays are served as one page to
  `getAllPages`. `ctx.esi.calls` records every call for asserting what the tool asked for (and what it didn't, e.g.
  "no DELETE happened").
- Names of characters/corps/alliances go through the real resolver: answer `POST /universe/names`. NPC entities,
  stations and types come from the SDE.
- For several calls on one connection (e.g. save then list), use `const conn = await connect(ctx)`,
  `await conn.call(name, args)`, then `await conn.close()`.

## Static data

- `sde` is the user's local index (or `null`); `withSde(...)` runs a test only when it exists, `test.skip` otherwise.
  Any tool that resolves names or types needs it, which is most of them. That's fine: CI builds the index.
- Tests that must run without the SDE pass `testCtx({ sde: null })`; the tool then fails loudly if it touches static
  data. Use real type names (`sde.typeIdByName("Rifter")`), never hard-coded type ids, so tests survive SDE updates.
- After an `SDE_SCHEMA_VERSION` bump, the local index is stale until the server rebuilds it. Run
  `node dist/index.js sde-update` before `npm test`, or new-schema tests will skip (and fail CI's no-skip check).
- To check the no-SDE path locally: `EVE_ESI_MCP_HOME=$(mktemp -d) node --test "dist/test/*.test.js"`.

## What every tool test should cover

- [ ] The happy path, asserting names, units and `character` in the output
- [ ] The tool's most likely failure: unknown name (candidates listed), missing scope (preset named), no character
      (`character_login` mentioned), or an ESI error in one part of a composite (the rest still returned)
- [ ] Bounded output where relevant: `limit` respected, `total` vs shown
- [ ] Write tools: the write was sent with the right scope and body; validation failures send nothing
      (`ctx.esi.calls.filter((c) => c.method !== "GET")` is empty); the server's own view is consistent afterwards

## Pitfalls

- Module-level state persists across tests in a file (e.g. pending fitting writes are keyed by character id). Give
  each test its own character id.
- The harness logs unexpected errors to stderr (`[eve-esi-mcp] Error: ...`). That's `errorReply` working; check
  whether the test expected an error.
- Don't snapshot whole responses. Assert the fields the model relies on, so harmless additions don't break tests.
- `tsc` doesn't delete compiled tests for removed source files. If a deleted test still runs, remove its file
  from `dist/test/`.

## Before you call it done

- [ ] `npm test` passes, with no new skips on a machine that has the SDE
- [ ] New or changed tools have handler tests; `UNTESTED` didn't grow (and shrank if you touched a listed tool)
- [ ] Bug fixes have a test that failed before the fix
- [ ] The PR lists what is unit-tested and what was checked live (`live-testing-eve-esi`)
