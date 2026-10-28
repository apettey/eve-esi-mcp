# Code patterns for eve-esi-mcp tools

Recipes for the building blocks every tool uses. Copy the shape and keep the style of the file you're editing.

## Contents
- [Where things live](#where-things-live)
- [Reading the ESI spec](#reading-the-esi-spec)
- [Tool skeleton](#tool-skeleton)
- [Characters and scopes](#characters-and-scopes)
- [Corporation routes (roles)](#corporation-routes)
- [ESI calls: single, paged, bulk, optional](#esi-calls)
- [Resolving names](#resolving-names)
- [Fuzzy input: items and systems](#fuzzy-input)
- [Composite tools with partial results](#composite-tools)
- [Formatting](#formatting)
- [Copyable text blocks](#copyable-text-blocks)
- [Write tools](#write-tools)
- [Adding static data to the SDE index](#adding-static-data)
- [Tests](#tests)

## Where things live

| Path | What |
| --- | --- |
| `src/tools/<area>.ts` | Tool registrations, grouped by area (`characters`, `character`, `assets`, `fittings`, `universe`, `economy`, `industry`, `comms`, `doctrine`, `raw`) |
| `src/server.ts` | `buildServer` (registers every area) and the server `INSTRUCTIONS` |
| `src/tools/helpers.ts` | `characterParam`, `reply`, `handler`, `section`, `READ_ONLY` |
| `src/context.ts` | `Ctx`: `ctx.esi`, `ctx.sde()`, `ctx.resolver`, `ctx.character()`, `ctx.maybeCharacter()`, `ctx.store`, `ctx.sso` |
| `src/esi/client.ts` | `Esi`: `get`, `post`, `request`, `getAllPages`, `tryGet`, `requireScope` |
| `src/esi/resolver.ts` | `entities`, `entityName`, `location(s)`, `structure`, `enrich` |
| `src/sde/db.ts` | `Sde`: types, attributes (`describeAttributes`, `formatAttribute`), skills, blueprints, systems, stations, wormholes |
| `src/sde/build.ts` | SDE JSONL → SQLite builder; `SDE_SCHEMA_VERSION` |
| `src/fit/` | Fit model (`model.ts`: EFT/DNA/ESI flags), rendering (`render.ts`), eve-fit engine client (`evefit.ts`) |
| `src/market.ts`, `src/skills.ts` | Market scope/summary/appraisal; skill loading, requirement closure, training time |
| `src/util.ts` | `UserError`, `mapLimit`, `chunk`, `unique`, `isk`, `duration`, `round`, `norm`, `compact`, `stripHtml` |
| `src/auth/scopes.ts` | Scope presets offered at login |
| `src/test/harness.ts` | Test helpers: `testCtx`, `FakeEsi`, `callTool`, `character`, `esiError`, `sde`/`withSde` |

## Reading the ESI spec

The live spec is about 600 KB of OpenAPI with `$ref`s, so don't hand-parse it. Use the bundled script:

```bash
node .claude/skills/adding-eve-tools/scripts/esi-route.mjs "corporations/{corporation_id}/structures"
node .claude/skills/adding-eve-tools/scripts/esi-route.mjs skyhook          # any substring of the path
```

It prints parameters, body/response shapes, pagination style, scope, required in-game roles (`x-required-roles`),
rate-limit group (`x-rate-limit`) and the compatibility date the route appeared in, and flags routes newer than the
server's `COMPATIBILITY_DATE`. Leave off the leading `/` in Git Bash on Windows, where it gets rewritten into a file
path (the script undoes the common case anyway).

- Rate-limit groups are per character and per app (e.g. `char-killmail` allows 30 tokens per 15 min). A tool that
  fans out over a small group (killmails, notifications) should cap how many calls it makes and say when it
  truncated. The client already backs off on 429.
- Optional response fields can carry meaning (no `fuel_expires` = low power). Note them while you read the shape.

## Tool skeleton

```ts
server.registerTool(
  "standings",
  {
    title: "Character standings",
    description:
      "A character's standings towards NPC factions, corporations and agents, with names, sorted best first. " +
      "Use it to check mission access or faction warfare eligibility.",
    inputSchema: {
      character: characterParam,
      filter: z.string().optional().describe("Only entries whose name contains this text, e.g. 'Caldari'."),
      limit: z.number().int().min(1).max(500).optional().describe("Max rows (default 50)."),
    },
    annotations: READ_ONLY,
  },
  handler(async ({ character, filter, limit }) => {
    const c = ctx.character(character);
    const rows = await ctx.esi.get<Array<{ from_id: number; from_type: string; standing: number }>>(
      `/characters/${c.id}/standings`, { character: c, scope: "esi-characters.read_standings.v1" },
    );
    const names = await ctx.resolver.entities(rows.map((r) => r.from_id));
    const f = filter ? norm(filter) : null;
    const all = rows
      .map((r) => ({ name: names.get(r.from_id)?.name ?? `#${r.from_id}`, kind: r.from_type, standing: round(r.standing, 2) }))
      .filter((r) => !f || norm(r.name).includes(f))
      .sort((a, b) => b.standing - a.standing);
    const shown = all.slice(0, limit ?? 50);
    return reply({ character: c.name, total: all.length, shown: shown.length, standings: shown });
  }),
);
```

Why `handler()`: it turns thrown `UserError`/`EsiError` into a readable tool error instead of a protocol failure, so
the model can recover. Why `READ_ONLY`: clients use the annotations to decide what needs confirmation.

## Characters and scopes

- Required character: `const c = ctx.character(character);`. It throws a helpful error if nobody is logged in or the
  name is ambiguous.
- Optional enrichment (skill checks on public data): `const c = ctx.maybeCharacter(character);`, which may be
  `undefined`. Check `c.scopes.includes(...)` before calling, and skip the enrichment quietly if it's missing.
- Always pass `scope:` on authenticated calls. `Esi.request` checks it before sending and raises
  "<name> has not granted <scope>. Call character_login…" instead of an opaque ESI 403.
- Corporation routes need the character's corp id: `(await ctx.esi.get<any>(`/characters/${c.id}`)).corporation_id`.
  They also need in-game roles, so expect 403 and explain it.

## Corporation routes

Corporation data needs three things: the scope, the character's corporation id, and an in-game role (from
`x-required-roles`, e.g. `Station_Manager`, `Director`, `Accountant`). The scope check is automatic; the other two
aren't. Resolve the corp and pre-check roles so the failure says what to do instead of a bare 403:

```ts
const pub = await ctx.esi.get<{ corporation_id: number; alliance_id?: number }>(`/characters/${c.id}`);
if (pub.corporation_id < 2_000_000) {
  throw new UserError(`${c.name} is in an NPC corporation, which has no ${what} data.`);
}
if (c.scopes.includes("esi-characters.read_corporation_roles.v1")) {
  const roles = await ctx.esi.get<{ roles?: string[] }>(`/characters/${c.id}/roles`, { character: c });
  const ok = (roles.roles ?? []).some((r) => r === "Director" || needed.includes(r));
  if (!ok) throw new UserError(`${c.name} needs the in-game ${needed.join(" or ")} role in their corporation to see this.`);
}
// then the actual call, with scope:
const { items } = await ctx.esi.getAllPages<T>(`/corporations/${pub.corporation_id}/structures`, {
  character: c, scope: "esi-corporations.read_structures.v1",
});
```

Directors have every role. If the roles scope isn't granted, skip the pre-check and let a 403 from the main call
explain itself via `describeError`, adding the role name in a catch if needed. Corporation scopes belong in
`FULL_SCOPES`. When several corporation tools exist, move this into a shared helper rather than copying it.

## ESI calls

```ts
const one   = await ctx.esi.get<T>(path, { character: c, scope });          // cached per Expires/ETag
const paged = await ctx.esi.getAllPages<T>(path, { character: c, scope });   // { items, pages, truncated }, X-Pages in parallel
const res   = await ctx.esi.post<T>("/universe/names", ids);                // POST with JSON body
const maybe = await ctx.esi.tryGet<T>(path, { character: c });              // null on 401/403/404 (optional extras only)
await mapLimit(list, 6, (x) => ctx.esi.get(...));                            // bounded concurrency
```

Use `tryGet` only for optional extras, such as a structure's name or a schematic's name, where "unknown" is a fine
answer. For the data the tool exists to return, let the error propagate (or explain it) so the model learns why
it's missing instead of getting an empty result that looks like "you have none".

The base client sends `X-Compatibility-Date`. If a route only exists after `COMPATIBILITY_DATE` in `src/config.ts`,
review `/meta/changelog` and bump the date deliberately; don't fork the client.

## Resolving names

```ts
const sde = await ctx.sde();
sde.typeName(typeId);                       // items, ships, skills, ...
sde.systemSummary(systemId);                // { name, security (as shown in game), security_band, region, wormhole_class, wormhole }
sde.station(stationId)?.name;               // NPC stations (names are built during indexing)
const names = await ctx.resolver.entities(ids);              // characters/corps/alliances/factions (batched, cached 7d)
const locs  = await ctx.resolver.locations(locationIds, c);  // stations, structures (needs scope + docking access), systems
const enriched = await ctx.resolver.enrich(rawEsiPayload, c); // adds *_name next to known *_id fields (generic fallback)
```

Prefer the specific calls in purpose-built tools. `enrich` is for generic payloads (`esi_request`) where you don't
know the shape. Collect ids first, resolve once, then map. Don't resolve inside a loop.

## Fuzzy input

```ts
import { typeRef, systemRef } from "./universe.js";
const typeId = typeRef(sde, "dc ii");   // id or name; shorthand aliases; throws "ambiguous: did you mean …" with candidates
const sysId  = systemRef(sde, "Jita");
```

For your own lookups (fits, ships, contracts by name), follow the same rule: exact match first, then a unique
substring, else return the candidates with ids so the model can retry precisely (see `ship_fitting`).

## Composite tools

```ts
const errors: Record<string, string> = {};
const [wallet, skills] = await Promise.all([
  section(errors, "wallet", () => ctx.esi.get<number>(`/characters/${c.id}/wallet`, { character: c, scope: "esi-wallet.read_character_wallet.v1" })),
  section(errors, "skills", () => loadSkills(ctx.esi, c)),
]);
return reply({ character: c.name, wallet: wallet != null ? isk(wallet) : undefined, ..., unavailable: Object.keys(errors).length ? errors : undefined });
```

Run independent parts in parallel and let each fail on its own.

## Formatting

- ISK: `isk(n)` gives "1.23b ISK". Durations: `duration(ms)` gives "4d 2h". Rounding: `round(n, 2)`.
- Attributes: `sde.describeAttributes(typeId, ...)` gives `{ category: { "Display Name": "40 tf" } }`, or use
  `moduleAttributes(sde, id, detail)` from `src/fit/render.ts` for the summary/full levels.
- Security: `sde.systemSummary` already shows the in-game rounded value; don't show raw true-sec.
- Dates: keep ESI's ISO strings, and add a relative `time_left`/`expires_in` when the model will reason about "when".

## Copyable text blocks

```ts
return reply({ ...rendered }, { texts: [rendered.eft] });
```

The JSON keeps the EFT field for structure, and the extra block holds the verbatim text to paste into the game, Pyfa
or eve-fit.

## Write tools

```ts
annotations: { openWorldHint: true },                    // + destructiveHint: true when it deletes
description: "... Confirm with the user before saving.",
```

- Resolve and validate everything first (names, recipients, ids), then perform the one write. Fail before writing,
  never halfway through.
- Return what was done, with ids (`fitting_id`, `mail_id`) and the character name.
- ESI list endpoints are cached server-side for minutes, so a list read right after a write is stale. Overlay
  this process's own writes, as `fittings.ts` does with `notePending`/`applyPendingWrites`.

## Adding static data

1. Look at the JSONL record in the SDE zip (`https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip`).
   Localized fields are `{en, de, ...}`; keep `en` via `en()`. Integer-keyed maps arrive as `[{_key, _value}]`; use `kv()`.
2. Add a table/columns in `SCHEMA` in `src/sde/build.ts`, insert rows in `buildSde`, and **bump `SDE_SCHEMA_VERSION`**.
   Installs rebuild automatically on the next start (about 100 MB download). The index filename includes the schema
   version, so a rebuild never collides with an open old file.
3. Add accessors on `Sde` in `src/sde/db.ts` (prepared via `this.q(sql)`).
4. Data the SDE lacks (e.g. wormhole statics) may be vendored as generated TypeScript (see
   `scripts/update-wormhole-statics.mjs`) only from a freely licensed source, credited in the README.

## Tests

The `testing-eve-esi` skill has the full guide. The short version for the `standings` skeleton above:

```ts
// src/test/tools-<area>.test.ts
import { callTool, character, testCtx, withSde } from "./harness.js";

const PILOT = character(90000401, "Standings Pilot");

withSde("standings are named and sorted best first", async () => {
  const ctx = testCtx({
    characters: [PILOT],
    esi: {
      [`/characters/${PILOT.id}/standings`]: [
        { from_id: 500001, from_type: "faction", standing: 5.5 },
        { from_id: 500002, from_type: "faction", standing: -2 },
      ],
    },
  });
  const r = await callTool(ctx, "standings", {});
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.character, "Standings Pilot");
  assert.deepEqual(r.json.standings.map((s: any) => s.name), ["Caldari State", "Minmatar Republic"]);
});

withSde("standings without the scope says which preset grants it", async () => {
  const ctx = testCtx({ characters: [character(90000402, "No Scopes", [])] });
  assert.match((await callTool(ctx, "standings", {})).text, /"standard" scope preset/);
});
```

- `src/test/tools.test.ts` fails for any registered tool without a handler test, checks that every tool has a
  title, description and annotations, and that write tools say "confirm". Add new write tools to `GAME_WRITES` there.
- External processes (eve-fit, zKillboard, SSO) get fakes, so `npm test` never needs them.
- Live behaviour: see the `live-testing-eve-esi` skill.
