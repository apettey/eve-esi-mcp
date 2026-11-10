import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Ctx } from "../context.js";
import { piData, tierName, type PiData } from "../pi.js";
import type { Sde } from "../sde/db.js";
import { checkPlan, type ActualColonies } from "../pi-check.js";
import { pinCosts } from "../pi-layout.js";
import {
  colonySheet, colonyTemplates, defaultTemplateFolder, haulLine, haulPerTrip, listPlans, loadPlan, planMarkdown, routine, type SavedPlan,
} from "../pi-plan.js";
import { templateFileName, templateText } from "../pi-template.js";
import { UserError, duration, isk, mapLimit } from "../util.js";
import { READ_ONLY, handler, reply } from "./helpers.js";

const day = (perHour: number) => isk(perHour * 24);

/** Keep the colonies of the characters asked for (all when none). A character group name expands to its members. */
function only(ctx: Ctx, p: SavedPlan, characters?: string[]): SavedPlan {
  if (!characters?.length) return p;
  const inPlan = new Set(p.colonies.map((c) => c.character.toLowerCase()));
  const want = characters.flatMap((ref) => {
    const r = ref.trim().toLowerCase();
    const group = inPlan.has(r) && !/^group:/i.test(ref) ? undefined : ctx.groups.find(ref);
    return group ? group.members.map((m) => m.name.toLowerCase()) : [r];
  });
  const colonies = p.colonies.filter((c) => want.includes(c.character.toLowerCase()));
  if (!colonies.length) {
    throw new UserError(`The plan has no colonies for ${characters.join(", ")}. Characters in it: ${[...new Set(p.colonies.map((c) => c.character))].join(", ")}.`);
  }
  return { ...p, colonies };
}

const SCOPE = "esi-planets.manage_planets.v1";

/** pi_plans `check`: each character's colonies from ESI against the plan. */
async function checkReply(ctx: Ctx, sde: Sde, pi: PiData, p: SavedPlan) {
  const now = Date.now();
  const names = [...new Set(p.colonies.map((c) => c.character))];
  const actual = new Map<string, ActualColonies | Error>();
  await mapLimit(names, 3, async (name) => {
    try {
      const c = ctx.character(name);
      const planets = (await ctx.esi.get<any[]>(`/characters/${c.id}/planets`, { character: c, scope: SCOPE }))
        .filter((x) => x.solar_system_id === p.system.id);
      const layouts = new Map<number, any>();
      await mapLimit(planets, 4, async (x) => {
        layouts.set(x.planet_id, await ctx.esi.get<any>(`/characters/${c.id}/planets/${x.planet_id}`, { character: c, scope: SCOPE }));
      });
      actual.set(name, { planets, layouts });
    } catch (err) {
      actual.set(name, err as Error);
    }
  });
  const ordered = new Map(names.filter((n) => actual.has(n)).map((n) => [n, actual.get(n)!]));
  const checks = checkPlan(sde, pi, p, ordered, now);
  const issues = checks.reduce((n, c) => n + c.colonies.reduce((m, x) => m + x.issues.length, 0) + c.extra.length + (c.unavailable ? 1 : 0), 0);
  const matching = checks.filter((c) => c.ok).length;
  return {
    name: p.name,
    system: p.system.name,
    summary: `${matching} of ${checks.length} characters match the plan` + (issues ? `; ${issues} issue${issues === 1 ? "" : "s"}` : ""),
    characters: checks.map((c) => ({
      character: c.character,
      status: c.unavailable ? "couldn't read colonies" : c.ok ? "matches the plan" : `${c.colonies.filter((x) => !x.ok).length + (c.extra.length ? 1 : 0)} to fix`,
      built: `${c.built} of ${c.planned} colonies`,
      colonies: c.colonies.map((x) => x.line),
      not_in_plan: c.extra.length ? c.extra.map((x) => `colony on ${x} isn't in the plan`) : undefined,
      data_age: c.oldestUpdateMs ? `${duration(now - c.oldestUpdateMs)} (oldest colony update)` : undefined,
      unavailable: c.unavailable,
    })),
    note: "ESI only refreshes a colony when it is opened in game; extractor head positions and hotspots can't be checked.",
  };
}

export function registerPiPlanTools(server: McpServer, ctx: Ctx) {
  server.registerTool(
    "pi_plans",
    {
      title: "Saved PI plans",
      description:
        "Saved planetary industry plans (pi_optimize with `save_as` saves one). Without `name`: the list of saved plans. With " +
        "`name`: that plan exactly as saved, the same every time: the routine for every undock (characters in order, each " +
        "planet's steps, exactly how much of each good to collect and which factory colony or the stockpile it goes to, cargo " +
        "m³), each colony (character, planet, what it makes, ISK/day at the " +
        "prices when saved, its template file name), goods moved between colonies, the haul per trip, a build sheet per colony " +
        "and, with `templates`, an importable EVE colony template per colony as extra text blocks. With `check`: whether what " +
        "each character built matches the plan, one line per colony (missing colonies, command center level, extractor " +
        "resources and heads (too few or too many), programs ended or of the wrong length, factory schematics and counts, unrouted inputs and " +
        "outputs, factory input stock and idle factories). pi_plan_export writes the templates to the game's template " +
        "folder. Read-only.",
      inputSchema: {
        name: z.string().optional().describe("Plan name, e.g. 'Home no imports'. Omit to list saved plans."),
        characters: z.array(z.string()).max(50).optional().describe("Only these characters' colonies (names or character group names)."),
        routine: z.boolean().optional().describe("Include the routine for every undock (default true)."),
        sheets: z.boolean().optional().describe("Include the build sheet per colony (default true)."),
        templates: z.boolean().optional().describe("Add each colony's template JSON as a text block, in colony order (default false)."),
        check: z.boolean().optional().describe("Compare what each character has built with the plan instead (reads their colonies from ESI)."),
      },
      annotations: READ_ONLY,
    },
    handler(async (a) => {
      if (!a.name) {
        const plans = listPlans(ctx.cfg.home);
        return reply({
          plans: plans.map((p) => ({
            name: p.name, system: p.system.name, saved: p.savedAt, isk_per_day: isk(p.totals.iskPerDay),
            colonies: p.colonies.length, characters: [...new Set(p.colonies.map((c) => c.character))],
          })),
          note: plans.length ? "pi_plans with `name` shows one; pi_plan_export writes its templates." : "No saved plans: run pi_optimize with `save_as`.",
        });
      }
      const sde = await ctx.sde();
      const pi = piData(sde);
      const full = loadPlan(ctx.cfg.home, a.name);
      const p = only(ctx, full, a.characters);
      if (a.check) return reply(await checkReply(ctx, sde, pi, p));
      const templates = colonyTemplates(sde, pi, pinCosts(sde), p);
      const h = haulPerTrip(sde, full);
      const r = a.routine === false ? undefined : routine(sde, pi, full);
      const keep = new Set(p.colonies.map((c) => c.character));
      return reply({
        name: p.name,
        system: p.system.name,
        saved: p.savedAt,
        prices: `${p.market}, when saved`,
        totals: {
          isk_per_day: isk(full.totals.iskPerDay),
          input_purchases_per_day: isk(full.totals.inputsPerDay),
          haul_in_m3_per_day: Math.round(full.totals.haulInM3PerDay),
          haul_out_m3_per_day: Math.round(full.totals.haulOutM3PerDay),
          colonies: full.colonies.length,
        },
        routine: r && {
          order: "Run the characters in this order, so the factories' inputs are in the shared hangar before their turn.",
          runs: r.runs.filter((x) => keep.has(x.character)).map((x) => ({
            character: x.character,
            every: x.every,
            cargo_m3: x.cargoM3.factoryVisit > x.cargoM3.everyVisit
              ? `${x.cargoM3.everyVisit.toLocaleString("en-US")}, ${x.cargoM3.factoryVisit.toLocaleString("en-US")} on factory days`
              : x.cargoM3.everyVisit.toLocaleString("en-US"),
            steps: x.steps,
          })),
          stockpile_per_day: r.stockpile.map(([t, n]) => `${sde.typeName(t)} ${Math.round(n).toLocaleString("en-US")}`),
          not_covered_per_day: r.short.length ? r.short.map(([t, n]) => `${sde.typeName(t)} ${Math.round(n).toLocaleString("en-US")}`) : undefined,
        },
        colonies: templates.map((t) => {
          const c = t.colony;
          return `${c.character}: ${c.planet.name} (${c.planet.type}) ${c.describe}. ~${day(c.iskPerHour)}/day. Template "${t.file}" ` +
            `(${t.template.P.length} structures, ${t.links}${t.fits ? "" : "; links push it over the command center"})`;
        }),
        haul_per_trip: {
          every: h.every,
          buy_and_bring_in: h.buy.length ? h.buy.map((x) => haulLine(sde, x)) : undefined,
          take_out_and_sell: h.sell.map((x) => `${haulLine(sde, x)} ${tierName(pi.tier.get(x[0]))}`),
          m3_in: Math.round(h.m3In),
          m3_out: Math.round(h.m3Out),
        },
        sheets: a.sheets === false ? undefined : templates.map((t) => ({ colony: t.name, steps: colonySheet(sde, pi, full, t.colony) })),
        template_note: a.templates ? "Each template's JSON follows as a text block, in the order of `colonies`." : undefined,
      }, { texts: a.templates ? templates.map((t) => templateText(t.template)) : [] });
    }),
  );

  server.registerTool(
    "pi_plan_export",
    {
      title: "Write a saved PI plan's colony templates",
      description:
        "Writes a saved PI plan (pi_optimize `save_as`) to disk: one EVE colony template per colony into the game's " +
        "template folder (default Documents\\EVE\\PlanetaryInteractionTemplates, or OneDrive's Documents when EVE lives there), one folder per character with 'Planet VI.json' per colony, " +
        "plus a markdown build book (overview, haul, a build sheet per colony). Files of the same name are replaced. Writes " +
        "files on this computer, so confirm with the user first (say the folder). In game: Planetary Industry view > Open " +
        "template, then pick the colony's template.",
      inputSchema: {
        name: z.string().optional().describe("Plan name (default: the most recently saved plan)."),
        characters: z.array(z.string()).max(50).optional().describe("Only these characters' colonies (names or character group names)."),
        folder: z.string().optional().describe("Folder for the templates (default: the EVE client's template folder)."),
        build_book: z.boolean().optional().describe("Also write '<plan name>.md' with every build sheet (default true)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    handler(async (a) => {
      const sde = await ctx.sde();
      const pi = piData(sde);
      const costs = pinCosts(sde);
      const p = only(ctx, loadPlan(ctx.cfg.home, a.name), a.characters);
      const folder = a.folder?.trim() || defaultTemplateFolder();
      const templates = colonyTemplates(sde, pi, costs, p);
      let replaced = 0;
      let book: string | undefined;
      try {
        mkdirSync(folder, { recursive: true });
        for (const t of templates) {
          const path = join(folder, t.file);
          mkdirSync(dirname(path), { recursive: true });
          if (existsSync(path)) replaced++;
          writeFileSync(path, templateText(t.template));
        }
        if (a.build_book !== false) {
          book = join(folder, templateFileName(p.name).replace(/\.json$/, ".md"));
          writeFileSync(book, planMarkdown(sde, pi, costs, p));
        }
      } catch (err) {
        throw new UserError(
          `Couldn't write to ${folder} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}). On Windows, Defender's ` +
          "Controlled Folder Access blocks programs it doesn't know from writing into Documents and reports it as a missing " +
          "file. Export to another folder (`folder`) and copy the files across in Explorer, allow Node.js through Controlled " +
          "Folder Access yourself, or paste each template from pi_plans `templates` (Open template > Import & Export > Load " +
          "from clipboard).",
        );
      }
      return reply({
        plan: p.name,
        folder,
        templates_written: templates.map((t) => t.file),
        replaced: replaced || undefined,
        build_book: book,
        over_command_center: templates.filter((t) => !t.fits).map((t) => `${t.file}: its links push it over the command center, drop a factory after importing`),
        next: "In game: Planetary Industry view > Open template (reopen the window if it was open), pick the colony's template and " +
          "place it; then drag each extractor's heads onto the hotspot and start its program.",
      });
    }),
  );
}
