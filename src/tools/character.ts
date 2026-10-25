import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Ctx } from "../context.js";
import type { StoredCharacter } from "../auth/store.js";
import type { Sde } from "../sde/db.js";
import { parseEft } from "../fit/model.js";
import { attributeName, cloneState, loadSkills, requirementClosure, skillGaps } from "../skills.js";
import { UserError, duration, isk, norm, round } from "../util.js";
import { READ_ONLY, characterParam, handler, reply, section } from "./helpers.js";
import { typeRef } from "./universe.js";

const INFOMORPH_SYNCHRONIZING = 33399;

const OVERVIEW_SECTIONS = ["identity", "location", "ship", "wallet", "skills", "clones", "fatigue", "loyalty"] as const;

async function implantSummary(sde: Sde, ids: number[]) {
  return ids
    .map((id) => ({ id, slot: sde.attr(id, 331) ?? 0 }))
    .sort((a, b) => a.slot - b.slot)
    .map((i) => `${i.slot ? `[${i.slot}] ` : ""}${sde.typeName(i.id)}`);
}

export async function currentLocation(ctx: Ctx, c: StoredCharacter) {
  const loc = await ctx.esi.get<any>(`/characters/${c.id}/location`, { character: c, scope: "esi-location.read_location.v1" });
  const sde = await ctx.sde();
  const dockedId = loc.station_id ?? loc.structure_id;
  const docked = dockedId ? await ctx.resolver.location(dockedId, c) : null;
  const wormhole = sde.wormholeSystem(loc.solar_system_id);
  return { system: { ...sde.systemSummary(loc.solar_system_id), wormhole: wormhole ?? undefined }, docked_at: docked?.name ?? null, docked_id: dockedId ?? null };
}

export function registerCharacterDataTools(server: McpServer, ctx: Ctx) {
  server.registerTool(
    "character_overview",
    {
      title: "Character overview",
      description:
        "One-call snapshot of a character: corp/alliance, security status, online state, current system/station, active ship, wallet, " +
        "SP and what's training (with alpha/omega inferred from training speed and capped skills), clones and implants (with clone-jump availability), jump fatigue and loyalty points. " +
        "Sections the character has no scope for are reported under 'unavailable' rather than failing.",
      inputSchema: {
        character: characterParam,
        sections: z.array(z.enum(OVERVIEW_SECTIONS)).optional().describe("Limit to these sections (default all)."),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ character, sections }) => {
      const c = ctx.character(character);
      const sde = await ctx.sde();
      const want = new Set(sections?.length ? sections : OVERVIEW_SECTIONS);
      const errors: Record<string, string> = {};
      const out: Record<string, unknown> = { character: c.name, character_id: c.id };
      const tasks: Promise<unknown>[] = [];
      const run = (name: (typeof OVERVIEW_SECTIONS)[number], fn: () => Promise<void>) => {
        if (want.has(name)) tasks.push(section(errors, name, fn));
      };

      run("identity", async () => {
        const [pub, online] = await Promise.all([
          ctx.esi.get<any>(`/characters/${c.id}`),
          c.scopes.includes("esi-location.read_online.v1")
            ? ctx.esi.get<any>(`/characters/${c.id}/online`, { character: c }) : Promise.resolve(null),
        ]);
        const n = await ctx.resolver.entities([pub.corporation_id, pub.alliance_id, pub.faction_id].filter(Boolean));
        out.identity = {
          corporation: n.get(pub.corporation_id)?.name,
          alliance: pub.alliance_id ? n.get(pub.alliance_id)?.name : undefined,
          faction: pub.faction_id ? n.get(pub.faction_id)?.name : undefined,
          security_status: pub.security_status != null ? round(pub.security_status, 2) : undefined,
          birthday: pub.birthday,
          title: pub.title,
          online: online?.online,
          last_login: online?.last_login,
        };
      });
      run("location", async () => { out.location = await currentLocation(ctx, c); });
      run("ship", async () => {
        const ship = await ctx.esi.get<any>(`/characters/${c.id}/ship`, { character: c, scope: "esi-location.read_ship_type.v1" });
        const t = sde.type(ship.ship_type_id);
        out.ship = { type: t?.name, group: t?.group, name: ship.ship_name, item_id: ship.ship_item_id };
      });
      run("wallet", async () => {
        const bal = await ctx.esi.get<number>(`/characters/${c.id}/wallet`, { character: c, scope: "esi-wallet.read_character_wallet.v1" });
        out.wallet = { balance: bal, formatted: isk(bal) };
      });
      run("skills", async () => {
        const [skills, queue] = await Promise.all([
          loadSkills(ctx.esi, c),
          c.scopes.includes("esi-skills.read_skillqueue.v1")
            ? ctx.esi.get<any[]>(`/characters/${c.id}/skillqueue`, { character: c }) : Promise.resolve(null),
        ]);
        const now = Date.now();
        const active = queue?.filter((q) => !q.finish_date || Date.parse(q.finish_date) > now) ?? [];
        const training = active.find((q) => q.start_date && Date.parse(q.start_date) <= now) ?? null;
        const last = active.at(-1);
        const clone = cloneState(sde, skills, queue);
        out.skills = {
          total_sp: skills.total_sp,
          unallocated_sp: skills.unallocated_sp,
          skills_trained: skills.levels.size,
          level_5_skills: [...skills.levels.values()].filter((s) => s.trained === 5).length,
          possibly_alpha: clone.possibly_alpha,
          clone_state: clone.evidence,
          queue: queue
            ? {
                training: training ? `${sde.typeName(training.skill_id)} ${training.finished_level}` : "nothing (queue paused or empty)",
                training_finishes: training?.finish_date,
                queued_skills: active.length,
                queue_ends: last?.finish_date,
                queue_time_left: last?.finish_date ? duration(Date.parse(last.finish_date) - now) : undefined,
              }
            : undefined,
        };
      });
      run("clones", async () => {
        const [clones, implants] = await Promise.all([
          ctx.esi.get<any>(`/characters/${c.id}/clones`, { character: c, scope: "esi-clones.read_clones.v1" }),
          c.scopes.includes("esi-clones.read_implants.v1")
            ? ctx.esi.get<number[]>(`/characters/${c.id}/implants`, { character: c }) : Promise.resolve(null),
        ]);
        const locs = await ctx.resolver.locations(
          [clones.home_location?.location_id, ...clones.jump_clones.map((j: any) => j.location_id)].filter(Boolean), c,
        );
        let syncLevel = 0;
        if (c.scopes.includes("esi-skills.read_skills.v1")) {
          const sk = await ctx.esi.get<any>(`/characters/${c.id}/skills`, { character: c });
          syncLevel = sk.skills.find((s: any) => s.skill_id === INFOMORPH_SYNCHRONIZING)?.active_skill_level ?? 0;
        }
        const cooldownMs = (24 - syncLevel) * 3600_000;
        const nextJump = clones.last_clone_jump_date ? Date.parse(clones.last_clone_jump_date) + cooldownMs : null;
        out.clones = {
          home_station: clones.home_location ? locs.get(clones.home_location.location_id)?.name : undefined,
          active_implants: implants ? await implantSummary(sde, implants) : undefined,
          clone_jump_available: nextJump == null || nextJump <= Date.now() ? "now" : `in ${duration(nextJump - Date.now())}`,
          jump_clones: await Promise.all(clones.jump_clones.map(async (j: any) => ({
            name: j.name || undefined,
            location: locs.get(j.location_id)?.name,
            system: locs.get(j.location_id)?.system?.name,
            implants: await implantSummary(sde, j.implants),
          }))),
        };
      });
      run("fatigue", async () => {
        const f = await ctx.esi.get<any>(`/characters/${c.id}/fatigue`, { character: c, scope: "esi-characters.read_fatigue.v1" });
        const exp = f.jump_fatigue_expire_date ? Date.parse(f.jump_fatigue_expire_date) : 0;
        out.jump_fatigue = exp > Date.now() ? { expires: f.jump_fatigue_expire_date, remaining: duration(exp - Date.now()) } : "none";
      });
      run("loyalty", async () => {
        const lp = await ctx.esi.get<any[]>(`/characters/${c.id}/loyalty/points`, { character: c, scope: "esi-characters.read_loyalty.v1" });
        const n = await ctx.resolver.entities(lp.map((l) => l.corporation_id));
        out.loyalty_points = lp
          .sort((a, b) => b.loyalty_points - a.loyalty_points)
          .slice(0, 10)
          .map((l) => `${n.get(l.corporation_id)?.name ?? l.corporation_id}: ${l.loyalty_points.toLocaleString("en-US")} LP`);
      });

      await Promise.all(tasks);
      if (Object.keys(errors).length) out.unavailable = errors;
      return reply(out);
    }),
  );

  server.registerTool(
    "character_skills",
    {
      title: "Character skills and queue",
      description:
        "A character's skills grouped by skill group (names and levels, not ids), attributes, and the training queue with finish times. " +
        "Use 'filter' to look at specific skills or groups (e.g. 'Gunnery', 'drone', 'Caldari').",
      inputSchema: {
        character: characterParam,
        filter: z.string().optional().describe("Only skills whose name or group contains this text."),
        include_queue: z.boolean().optional().describe("Include the skill queue (default true)."),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ character, filter, include_queue }) => {
      const c = ctx.character(character);
      const sde = await ctx.sde();
      const sk = await loadSkills(ctx.esi, c);
      const f = filter ? norm(filter) : null;
      const groups: Record<string, { sp: number; skills: string[] }> = {};
      for (const [id, s] of sk.levels) {
        const t = sde.type(id);
        const name = t?.name ?? `Skill ${id}`;
        const group = t?.group ?? "Unknown";
        if (f && !norm(name).includes(f) && !norm(group).includes(f)) continue;
        const g = (groups[group] ??= { sp: 0, skills: [] });
        g.sp += s.sp;
        g.skills.push(`${name} ${s.trained}${s.active !== s.trained ? ` (active ${s.active}, alpha-limited)` : ""}`);
      }
      for (const g of Object.values(groups)) g.skills.sort();
      let queue: unknown;
      let clone = cloneState(sde, sk);
      if (include_queue !== false && c.scopes.includes("esi-skills.read_skillqueue.v1")) {
        const q = await ctx.esi.get<any[]>(`/characters/${c.id}/skillqueue`, { character: c });
        clone = cloneState(sde, sk, q);
        const now = Date.now();
        queue = q
          .filter((x) => !x.finish_date || Date.parse(x.finish_date) > now)
          .sort((a, b) => a.queue_position - b.queue_position)
          .map((x) => ({
            skill: `${sde.typeName(x.skill_id)} ${x.finished_level}`,
            finishes: x.finish_date,
            time_left: x.finish_date ? duration(Date.parse(x.finish_date) - now) : "paused",
          }));
      }
      return reply({
        character: c.name,
        total_sp: sk.total_sp,
        unallocated_sp: sk.unallocated_sp,
        clone_state: clone.evidence,
        attributes: Object.fromEntries(Object.entries(sk.attributes).map(([k, v]) => [attributeName(Number(k)), v])),
        skill_groups: Object.fromEntries(Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))),
        queue,
      });
    }),
  );

  server.registerTool(
    "skill_check",
    {
      title: "Can the character use this?",
      description:
        "Checks whether a character can use items (ships, modules, ammo, drones) or a whole EFT fit. Includes all prerequisite skills, " +
        "missing levels, SP needed and estimated training time (from the character's attributes), and a training order. " +
        "Can compare several characters at once.",
      inputSchema: {
        items: z.array(z.union([z.string(), z.number()])).max(30).optional().describe("Item names or ids."),
        eft: z.string().optional().describe("An EFT fit to check as a whole."),
        characters: z.array(z.string()).optional().describe("Characters to compare (default: the active character)."),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ items, eft, characters }) => {
      const sde = await ctx.sde();
      const typeIds: number[] = (items ?? []).map((i) => typeRef(sde, i));
      let fitName: string | undefined;
      if (eft) {
        const { fit } = parseEft(sde, eft);
        fitName = `${sde.typeName(fit.ship_type_id)}, ${fit.name}`;
        typeIds.push(fit.ship_type_id);
        for (const slots of Object.values(fit.slots)) for (const m of slots) if (m) {
          typeIds.push(m.type_id);
          if (m.charge_type_id) typeIds.push(m.charge_type_id);
        }
        for (const d of [...fit.drones, ...fit.fighters]) typeIds.push(d.type_id);
      }
      if (!typeIds.length) throw new UserError("Provide items and/or an EFT fit.");
      const chars = (characters?.length ? characters : [undefined]).map((r) => ctx.character(r));
      const results = await Promise.all(chars.map(async (c) => {
        const sk = await loadSkills(ctx.esi, c);
        const perItem = [...new Set(typeIds)].map((id) => {
          const g = skillGaps(sde, requirementClosure(sde, [id]), sk);
          return { item: sde.typeName(id), can_use: g.can_use, training_time: g.can_use ? undefined : g.total_training_time };
        });
        const all = skillGaps(sde, requirementClosure(sde, typeIds), sk);
        // Train prerequisites first: order by how deep each skill's own requirement chain is.
        const depth = (id: number, seen = new Set<number>()): number => {
          if (seen.has(id)) return 0;
          seen.add(id);
          return 1 + Math.max(0, ...sde.requiredSkills(id).map((r) => depth(r.skill_id, seen)));
        };
        const plan = all.missing
          .map((m) => ({ ...m, d: depth(m.skill_id) }))
          .sort((a, b) => a.d - b.d || a.skill.localeCompare(b.skill))
          .flatMap((m) => Array.from({ length: m.required_level - m.trained_level }, (_, i) => `${m.skill} ${m.trained_level + i + 1}`));
        return {
          character: c.name,
          can_use_everything: all.can_use,
          total_sp_needed: all.total_sp_needed,
          total_training_time: all.total_training_time,
          items: perItem,
          missing_skills: all.missing,
          training_plan: plan.length ? plan : undefined,
        };
      }));
      return reply({
        checked: fitName ?? [...new Set(typeIds)].map((i) => sde.typeName(i)),
        note: "Training times use the attributes ESI reports for the character; boosters/accelerators are not modelled.",
        results,
      });
    }),
  );
}
