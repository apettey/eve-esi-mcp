import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Ctx } from "../context.js";
import type { StoredCharacter } from "../auth/store.js";
import { CATEGORY, type Sde } from "../sde/db.js";
import { fitFromFlaggedItems, parseEft, toEft, toEsiItems, type Fit } from "../fit/model.js";
import { renderFit } from "../fit/render.js";
import { EVE_FIT_NOT_CONFIGURED, fitStats } from "../fit/evefit.js";
import { loadCargoAmmo } from "../fit/ammo.js";
import { loadSkills, type CharacterSkills } from "../skills.js";
import { UserError, log, norm } from "../util.js";
import { READ_ONLY, characterParam, handler, reply } from "./helpers.js";
import { loadAssets, pathOf, rootOf } from "./assets.js";

export interface EsiFitting {
  fitting_id: number;
  name: string;
  description: string;
  ship_type_id: number;
  items: Array<{ type_id: number; flag: string; quantity: number }>;
}

const loadAmmoParam = z
  .boolean()
  .optional()
  .describe(
    "For engine stats only: load empty turrets/launchers with compatible ammo from the fit's cargo (default true), " +
      "so DPS isn't 0 for saved fittings, which keep ammo in cargo.",
  );

const detailParam = z
  .enum(["none", "summary", "full"])
  .optional()
  .describe("Per-module attribute detail: none, summary (default; fitting-relevant categories) or full.");

async function skillsFor(ctx: Ctx, c: StoredCharacter | undefined, wanted: boolean | undefined) {
  if (wanted === false || !c || !c.scopes.includes("esi-skills.read_skills.v1")) return undefined;
  try {
    return await loadSkills(ctx.esi, c);
  } catch {
    return undefined;
  }
}

/** Fittings saved/deleted by this process that ESI's cached list may not show yet. */
export interface PendingFittingWrites {
  saved: EsiFitting[];
  deleted: Set<number>;
  until: number;
}

// ESI serves the fittings list from a ~5 minute server-side cache, so a fit saved or deleted here would otherwise be
// missing from (or still in) fittings_list, fitting_get and fitting_delete for that long.
const PENDING_MS = 10 * 60_000;
const pendingWrites = new Map<number, PendingFittingWrites>();

function notePending(characterId: number, apply: (p: PendingFittingWrites) => void) {
  let p = pendingWrites.get(characterId);
  if (!p || p.until < Date.now()) pendingWrites.set(characterId, (p = { saved: [], deleted: new Set(), until: 0 }));
  p.until = Date.now() + PENDING_MS;
  apply(p);
}

export function applyPendingWrites(fits: EsiFitting[], p: PendingFittingWrites | undefined, now = Date.now()): EsiFitting[] {
  if (!p || p.until < now) return fits;
  const known = new Set(fits.map((f) => f.fitting_id));
  return [...fits, ...p.saved.filter((f) => !known.has(f.fitting_id))].filter((f) => !p.deleted.has(f.fitting_id));
}

/** Active implants of the character, if the token allows it (only used to make engine stats exact). */
async function activeImplants(ctx: Ctx, c: StoredCharacter): Promise<number[] | undefined> {
  if (!c.scopes.includes("esi-clones.read_implants.v1")) return undefined;
  try {
    return await ctx.esi.get<number[]>(`/characters/${c.id}/implants`, { character: c, scope: "esi-clones.read_implants.v1" });
  } catch {
    return undefined;
  }
}

/** Engine stats for renderFit (`stats`, or `statsNote` saying why not); never throws. */
async function engineStats(
  ctx: Ctx, sde: Sde, fit: Fit, skills: CharacterSkills | undefined, c: StoredCharacter | undefined,
  ammo: { load?: boolean; cargo?: Fit["cargo"] } = {},
) {
  const engine = fitStats();
  if (!engine) return { statsNote: EVE_FIT_NOT_CONFIGURED };
  try {
    // Implants listed in the fit itself win over the character's current ones.
    const implants = skills && c && !fit.implants.length ? await activeImplants(ctx, c) : undefined;
    // Only the engine's copy gets cargo ammo loaded; the displayed slots/EFT/DNA stay as the fit really is.
    const loaded = ammo.load !== false ? loadCargoAmmo(sde, fit, ammo.cargo) : undefined;
    return {
      stats: await engine.compute({
        eft: toEft(sde, loaded?.fit ?? fit), skills, characterName: c?.name, implants,
        assumedCharges: loaded?.assumed, unloadedWeapons: loaded?.unloaded,
      }),
    };
  } catch (err) {
    log("eve-fit stats failed:", (err as Error).message);
    return { statsNote: `Accurate stats unavailable: eve-fit failed (${(err as Error).message}).` };
  }
}

async function savedFittings(ctx: Ctx, c: StoredCharacter): Promise<EsiFitting[]> {
  const fits = await ctx.esi.get<EsiFitting[]>(`/characters/${c.id}/fittings`, { character: c, scope: "esi-fittings.read_fittings.v1" });
  return applyPendingWrites(fits, pendingWrites.get(c.id));
}

function matchFittings(sde: Sde, fits: EsiFitting[], ref: string | number): EsiFitting[] {
  const id = Number(ref);
  if (Number.isInteger(id)) {
    const f = fits.find((x) => x.fitting_id === id);
    if (f) return [f];
  }
  const n = norm(String(ref));
  const exact = fits.filter((f) => norm(f.name) === n);
  if (exact.length) return exact;
  const byName = fits.filter((f) => norm(f.name).includes(n));
  if (byName.length) return byName;
  return fits.filter((f) => norm(sde.typeName(f.ship_type_id)).includes(n));
}

function fitTexts(rendered: Array<{ eft: string }>) {
  return rendered.map((r) => r.eft);
}

export function registerFittingTools(server: McpServer, ctx: Ctx) {
  server.registerTool(
    "fittings_list",
    {
      title: "List saved fittings",
      description:
        "Lists a character's saved in-game fittings with ship names and module counts. Filter by fit name or ship. " +
        "Set include_eft to get every fit as EFT text in the same call.",
      inputSchema: {
        character: characterParam,
        filter: z.string().optional().describe("Substring of fitting name or ship type/group (e.g. 'Gila', 'PvE', 'frigate')."),
        include_eft: z.boolean().optional().describe("Include EFT text for each fit (default false)."),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ character, filter, include_eft }) => {
      const c = ctx.character(character);
      const sde = await ctx.sde();
      const fits = await savedFittings(ctx, c);
      const f = filter ? norm(filter) : null;
      const rows = fits
        .filter((x) => {
          if (!f) return true;
          const t = sde.type(x.ship_type_id);
          return [x.name, t?.name, t?.group].some((s) => s && norm(s).includes(f));
        })
        .sort((a, b) => sde.typeName(a.ship_type_id).localeCompare(sde.typeName(b.ship_type_id)) || a.name.localeCompare(b.name))
        .map((x) => {
          const fit = fitFromFlaggedItems(sde, x.name, x.ship_type_id, x.items, x.description);
          return {
            fitting_id: x.fitting_id,
            name: x.name,
            ship: sde.typeName(x.ship_type_id),
            ship_group: sde.type(x.ship_type_id)?.group,
            modules: x.items.filter((i) => /Slot\d/.test(i.flag)).length,
            description: x.description || undefined,
            eft: include_eft ? toEft(sde, fit) : undefined,
          };
        });
      return reply({ character: c.name, count: rows.length, total_saved: fits.length, fittings: rows });
    }),
  );

  server.registerTool(
    "fitting_get",
    {
      title: "Get saved fitting(s) in full",
      description:
        "Full detail for saved fittings, by id, name or ship: modules per slot by name, loaded charges, drones/cargo, CPU/PG/calibration " +
        "usage vs ship output, hardpoints, ship stats and bonuses, attributes of every module, a skill check against the character " +
        "(missing skills + training time), plus EFT (ready for in-game import or Pyfa) and DNA. Wormhole roller fits also get " +
        "cold/hot jump mass per prop module and roller advice.",
      inputSchema: {
        fittings: z.array(z.union([z.string(), z.number()])).min(1).max(10).describe("Fitting ids, names (substring) or ship names."),
        character: characterParam,
        attributes: detailParam,
        check_skills: z.boolean().optional().describe("Check skills of the character (default true)."),
        load_cargo_ammo: loadAmmoParam,
      },
      annotations: READ_ONLY,
    },
    handler(async ({ fittings, character, attributes, check_skills, load_cargo_ammo }) => {
      const c = ctx.character(character);
      const sde = await ctx.sde();
      const all = await savedFittings(ctx, c);
      const selected = new Map<number, EsiFitting>();
      const missing: string[] = [];
      for (const ref of fittings) {
        const m = matchFittings(sde, all, ref);
        if (!m.length) missing.push(String(ref));
        for (const f of m.slice(0, 10)) selected.set(f.fitting_id, f);
      }
      if (!selected.size) {
        throw new UserError(`No saved fittings match ${missing.join(", ")}. ${c.name} has ${all.length} fittings; use fittings_list.`);
      }
      const skills = await skillsFor(ctx, c, check_skills);
      const rendered: Array<{ fitting_id: number } & ReturnType<typeof renderFit>> = [];
      for (const f of [...selected.values()].slice(0, 10)) {
        const fit = fitFromFlaggedItems(sde, f.name, f.ship_type_id, f.items, f.description);
        rendered.push({
          fitting_id: f.fitting_id,
          ...renderFit(sde, fit, {
            detail: attributes, skills, characterName: c.name,
            ...(await engineStats(ctx, sde, fit, skills, c, { load: load_cargo_ammo })),
          }),
        });
      }
      return reply(
        { character: c.name, fittings: rendered, not_found: missing.length ? missing : undefined },
        { texts: fitTexts(rendered) },
      );
    }),
  );

  server.registerTool(
    "ship_fitting",
    {
      title: "Fit of an actual ship",
      description:
        "Reads how a real ship in the character's assets is fitted (default: the ship they are flying) and returns the same rich output " +
        "as fitting_get: named modules/charges per slot, drones, cargo, resources, attributes, skill check, EFT and DNA. " +
        "Note ESI caches assets for up to an hour, so very recent refits may not show yet.",
      inputSchema: {
        ship: z.union([z.string(), z.number()]).optional().describe("'current' (default), a ship item_id, or a ship type/custom name."),
        character: characterParam,
        attributes: detailParam,
        include_cargo: z.boolean().optional().describe("Include cargo/other holds (default true)."),
        load_cargo_ammo: loadAmmoParam,
      },
      annotations: READ_ONLY,
    },
    handler(async ({ ship, character, attributes, include_cargo, load_cargo_ammo }) => {
      const c = ctx.character(character);
      const sde = await ctx.sde();
      const index = await loadAssets(ctx, c);
      let shipItem;
      const ref = ship ?? "current";
      if (ref === "current") {
        const cur = await ctx.esi.get<any>(`/characters/${c.id}/ship`, { character: c, scope: "esi-location.read_ship_type.v1" });
        shipItem = index.byId.get(cur.ship_item_id);
        if (!shipItem) {
          throw new UserError(
            `${c.name} is flying a ${sde.typeName(cur.ship_type_id)} ('${cur.ship_name}') but it is not in the asset list yet ` +
              "(ESI caches assets for up to an hour, and capsules have no fit).",
          );
        }
      } else {
        const asNum = Number(ref);
        const ships = index.items.filter((a) => a.is_singleton && sde.type(a.type_id)?.category_id === CATEGORY.ship);
        shipItem = Number.isInteger(asNum) ? index.byId.get(asNum) : undefined;
        if (!shipItem) {
          const n = norm(String(ref));
          const matches = ships.filter((a) => norm(index.names.get(a.item_id) ?? "") === n || norm(sde.typeName(a.type_id)) === n);
          const loose = matches.length ? matches : ships.filter((a) => norm(index.names.get(a.item_id) ?? "").includes(n) || norm(sde.typeName(a.type_id)).includes(n));
          if (loose.length > 1) {
            return reply({
              ambiguous: true,
              message: "Several ships match; call again with an item_id.",
              candidates: loose.slice(0, 25).map((a) => ({
                item_id: a.item_id, ship: sde.typeName(a.type_id), name: index.names.get(a.item_id),
                location: index.roots.get(rootOf(index, a).location_id)?.name,
              })),
            });
          }
          shipItem = loose[0];
        }
        if (!shipItem) throw new UserError(`No assembled ship matching "${ref}" in ${c.name}'s assets. Try assets with mode 'ships'.`);
      }
      const all = (index.children.get(shipItem.item_id) ?? []).map((x) => ({ type_id: x.type_id, flag: x.location_flag, quantity: x.quantity }));
      const contents = all.filter((x) => include_cargo !== false || /Slot\d|DroneBay|FighterBay/.test(x.flag));
      // Ammo for engine stats comes from the real cargo hold even when it is hidden from the output.
      const cargo = all.filter((x) => x.flag === "Cargo");
      const name = index.names.get(shipItem.item_id) ?? sde.typeName(shipItem.type_id);
      const fit: Fit = fitFromFlaggedItems(sde, name, shipItem.type_id, contents);
      const skills = await skillsFor(ctx, c, true);
      const loc = index.roots.get(rootOf(index, shipItem).location_id);
      const rendered = renderFit(sde, fit, {
        detail: attributes, skills, characterName: c.name,
        ...(await engineStats(ctx, sde, fit, skills, c, { load: load_cargo_ammo, cargo })),
      });
      return reply(
        {
          character: c.name,
          item_id: shipItem.item_id,
          location: loc?.name,
          system: loc?.system?.name,
          path: pathOf(sde, index, shipItem),
          ...rendered,
        },
        { texts: [rendered.eft] },
      );
    }),
  );

  server.registerTool(
    "fitting_analyze",
    {
      title: "Analyze an EFT fit",
      description:
        "Parses any EFT text (from the user, Pyfa, zKillboard, ...) and returns the same rich breakdown as fitting_get: resolved names, " +
        "resource usage, ship stats/bonuses, module attributes, skill check against a character and DNA, plus engine stats " +
        "(EHP, DPS, cap, speed, real CPU/PG) when eve-fit is configured, and jump mass + advice for wormhole roller fits. " +
        "Does not save anything.",
      inputSchema: {
        eft: z.string().describe("EFT text starting with [Ship, Name]."),
        character: characterParam,
        attributes: detailParam,
        load_cargo_ammo: loadAmmoParam,
      },
      annotations: READ_ONLY,
    },
    handler(async ({ eft, character, attributes, load_cargo_ammo }) => {
      const sde = await ctx.sde();
      const { fit, warnings } = parseEft(sde, eft);
      const c = ctx.maybeCharacter(character);
      const skills = await skillsFor(ctx, c, true);
      const rendered = renderFit(sde, fit, {
        detail: attributes, skills, characterName: c?.name,
        ...(await engineStats(ctx, sde, fit, skills, c, { load: load_cargo_ammo })),
      });
      return reply({ warnings: warnings.length ? warnings : undefined, ...rendered }, { texts: [rendered.eft] });
    }),
  );

  server.registerTool(
    "fitting_save",
    {
      title: "Save a fitting in-game",
      description:
        "Saves an EFT fit to the character's in-game saved fittings (requires esi-fittings.write_fittings.v1). Names are resolved " +
        "from static data. ESI cannot store charges per slot, so loaded charges are dropped (with a warning) unless they are also in " +
        "the cargo section. Returns the new fitting_id. " +
        "Confirm with the user before saving.",
      inputSchema: {
        eft: z.string().describe("EFT text starting with [Ship, Name]."),
        name: z.string().max(50).optional().describe("Override the fitting name (max 50 chars)."),
        description: z.string().max(500).optional(),
        character: characterParam,
      },
      annotations: { openWorldHint: true },
    },
    handler(async ({ eft, name, description, character }) => {
      const c = ctx.character(character);
      const sde = await ctx.sde();
      const { fit, warnings } = parseEft(sde, eft);
      if (name) fit.name = name;
      // ESI fittings have no per-slot charges; warn when a loaded charge would be silently dropped.
      for (const slots of Object.values(fit.slots)) for (const m of slots) {
        if (m?.charge_type_id && !fit.cargo.some((x) => x.type_id === m.charge_type_id)) {
          warnings.push(`Loaded charge ${sde.typeName(m.charge_type_id)} is not stored per slot by ESI; add it to cargo if you want it saved.`);
        }
      }
      const body = {
        name: fit.name.slice(0, 50),
        description: description ?? fit.description ?? "",
        ship_type_id: fit.ship_type_id,
        items: toEsiItems(fit),
      };
      const res = await ctx.esi.post<{ fitting_id: number }>(`/characters/${c.id}/fittings`, body, {
        character: c, scope: "esi-fittings.write_fittings.v1",
      });
      notePending(c.id, (p) => p.saved.push({ fitting_id: res.fitting_id, ...body }));
      return reply({
        saved: true,
        character: c.name,
        fitting_id: res.fitting_id,
        name: body.name,
        ship: sde.typeName(fit.ship_type_id),
        items: body.items.length,
        warnings: [...new Set(warnings)],
      });
    }),
  );

  server.registerTool(
    "fitting_delete",
    {
      title: "Delete a saved fitting",
      description: "Deletes one saved in-game fitting by id or exact name. Only do this when the user explicitly asks, and confirm with the user first.",
      inputSchema: {
        fitting: z.union([z.number(), z.string()]).describe("Fitting id or exact name."),
        character: characterParam,
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    handler(async ({ fitting, character }) => {
      const c = ctx.character(character);
      const sde = await ctx.sde();
      const all = await savedFittings(ctx, c);
      const id = Number(fitting);
      const matches = Number.isInteger(id) ? all.filter((f) => f.fitting_id === id) : all.filter((f) => norm(f.name) === norm(String(fitting)));
      if (matches.length !== 1) {
        throw new UserError(matches.length ? `Several fittings are named "${fitting}"; use the fitting_id.` : `No fitting "${fitting}".`);
      }
      await ctx.esi.request("DELETE", `/characters/${c.id}/fittings/${matches[0].fitting_id}`, {
        character: c, scope: "esi-fittings.write_fittings.v1",
      });
      notePending(c.id, (p) => p.deleted.add(matches[0].fitting_id));
      return reply({ deleted: matches[0].name, ship: sde.typeName(matches[0].ship_type_id), fitting_id: matches[0].fitting_id });
    }),
  );
}

