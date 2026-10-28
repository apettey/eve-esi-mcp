import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Ctx } from "../context.js";
import { type DoctrineBundle, type Killmail, type KmParticipant, buildDoctrine, compSummary } from "../doctrine.js";
import { type RelatedPilot, type ZkillRef, ZKILL_BASE, parseZkillUrl, relatedTime } from "../zkill.js";
import { UserError, log, mapLimit, unique } from "../util.js";
import { READ_ONLY, handler, reply } from "./helpers.js";
import { systemRef, typeRef } from "./universe.js";

type MemberField = "alliance_id" | "corporation_id" | "character_id";
interface Member { field: MemberField; id: number; name: string }

const FIELD_BY_CATEGORY: Record<string, MemberField> = { alliance: "alliance_id", corporation: "corporation_id", character: "character_id" };
const ZKILL_FILTER: Record<MemberField, string> = { alliance_id: "allianceID", corporation_id: "corporationID", character_id: "characterID" };

const BUNDLE_NOTE =
  "Pass the result unchanged to the eve-fit MCP's save_doctrine(**bundle), then analyze_doctrine / fleet_battle / counter_fit.";

/** Killmail refs as "id/hash", an ESI killmail URL, or {killmail_id, killmail_hash}. */
function parseKillRef(r: string | { killmail_id: number; killmail_hash: string }): ZkillRef | { kind: "kill"; id: number } {
  if (typeof r !== "string") return { kind: "zkill", id: r.killmail_id, hash: r.killmail_hash };
  const m = /(\d+)\/([0-9a-f]{40})/i.exec(r);
  if (m) return { kind: "zkill", id: Number(m[1]), hash: m[2].toLowerCase() };
  if (/^\d+$/.test(r.trim())) return { kind: "kill", id: Number(r.trim()) };
  const t = parseZkillUrl(r);
  if (t.kind !== "kill") throw new UserError(`"${r}" is not a killmail: use "id/hash", an ESI killmail URL or a zkillboard.com/kill/<id>/ link.`);
  return t;
}

export function registerDoctrineTools(server: McpServer, ctx: Ctx) {
  /** Alliance/corporation/character by exact name or id. */
  async function resolveMember(ref: string, only?: MemberField): Promise<Member> {
    const asNum = Number(ref);
    if (Number.isInteger(asNum) && asNum > 0) {
      const e = (await ctx.resolver.entities([asNum])).get(asNum);
      const field = e && FIELD_BY_CATEGORY[e.category];
      if (!field || (only && field !== only)) throw new UserError(`${ref} is not ${only ? `a${only === "alliance_id" ? "n" : ""} ${only.replace("_id", "")}` : "an alliance, corporation or character"} id.`);
      return { field, id: asNum, name: e!.name };
    }
    const res = await ctx.esi.post<Record<string, Array<{ id: number; name: string }>>>("/universe/ids", [ref]);
    for (const [key, field] of [["alliances", "alliance_id"], ["corporations", "corporation_id"], ["characters", "character_id"]] as const) {
      if (only && field !== only) continue;
      const hit = (res[key] ?? []).find((e) => e.name.toLowerCase() === ref.toLowerCase());
      if (hit) return { field, id: hit.id, name: hit.name };
    }
    throw new UserError(`No ${only ? only.replace("_id", "") : "alliance, corporation or character"} named "${ref}" (names must be exact; try lookup).`);
  }

  async function fetchKillmails(refs: ZkillRef[]): Promise<{ kms: Killmail[]; failed: number }> {
    const byId = new Map(refs.map((r) => [r.id, r]));
    const got = await mapLimit([...byId.values()], 8, (r) =>
      ctx.esi.get<Killmail>(`/killmails/${r.id}/${r.hash}`).then((k) => ({ ...k, killmail_id: r.id })).catch((err) => {
        log(`killmail ${r.id}: ${(err as Error).message}`);
        return null;
      }),
    );
    const kms = got.filter((k): k is Killmail => k !== null);
    return { kms, failed: got.length - kms.length };
  }

  const isMemberOf = (members: Member[]) => (p: KmParticipant) => members.some((m) => p[m.field] === m.id);

  /** Without an explicit side, the pilots counted are the victims' alliances (or corporations, when not in one). */
  function victimSide(kms: Killmail[]) {
    const alliances = new Set<number>();
    const corps = new Set<number>();
    for (const k of kms) {
      if (k.victim.alliance_id) alliances.add(k.victim.alliance_id);
      else if (k.victim.corporation_id) corps.add(k.victim.corporation_id);
    }
    return (p: KmParticipant) => (p.alliance_id ? alliances.has(p.alliance_id) : !!p.corporation_id && corps.has(p.corporation_id));
  }

  function timeSpan(kms: Killmail[]) {
    const t = kms.map((k) => k.killmail_time).sort();
    return t.length ? `${t[0].replace("T", " ").replace("Z", "")} to ${t[t.length - 1].replace("T", " ").replace("Z", "")} UTC` : "";
  }

  server.registerTool(
    "doctrine_from_killmails",
    {
      title: "Enemy doctrine from killmails",
      description:
        "Builds an enemy fleet doctrine from killmails: which hulls a group flies (unique pilots per hull), each loss's fit as EFT " +
        "(fitted modules + loaded charges, burst charges included), and the weapons seen on their kills. Input zKillboard URLs " +
        "(alliance/corporation/character/ship/system pages, with /losses/ or /kills/), filters (alliance, corporation, character, " +
        "ship, past_hours), or killmail id+hash pairs; killmails are read from ESI. Pilots counted are the URL's or filter's " +
        "entity, or `members_of`, else the victims' alliances. " + BUNDLE_NOTE + " For a fight between two sides use doctrine_from_battle_report.",
      inputSchema: {
        urls: z.array(z.string()).max(10).optional().describe("zKillboard URLs, e.g. 'https://zkillboard.com/alliance/99003581/losses/'."),
        alliance: z.string().optional().describe("Alliance name or id, e.g. 'Fraternity.'."),
        corporation: z.string().optional().describe("Corporation name or id."),
        character: z.string().optional().describe("Character name or id."),
        ship: z.string().optional().describe("Only killmails involving this hull, e.g. 'Nighthawk'."),
        side: z.enum(["all", "losses", "kills"]).optional().describe("For filters: the entity's losses (fits), kills (hulls + weapons) or both (default)."),
        past_hours: z.number().int().min(1).max(168).optional().describe("Only the last N hours (zKillboard allows up to 7 days)."),
        killmails: z
          .array(z.union([z.string(), z.object({ killmail_id: z.number().int(), killmail_hash: z.string() })]))
          .max(300)
          .optional()
          .describe("Specific killmails: 'id/hash', ESI killmail URLs, zkillboard.com/kill/<id>/ links or {killmail_id, killmail_hash}."),
        members_of: z.array(z.string()).max(10).optional().describe("Alliances/corporations/characters (names or ids) whose pilots form the doctrine; overrides the default."),
        max_kills: z.number().int().min(1).max(300).optional().describe("Max killmails read per URL or filter (default 100)."),
        name: z.string().optional().describe("Doctrine name (default from the entity, e.g. 'Fraternity. comp')."),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ urls, alliance, corporation, character, ship, side, past_hours, killmails, members_of, max_kills, name }) => {
      const sde = await ctx.sde();
      const max = max_kills ?? 100;
      const notes: string[] = [];
      const refs: ZkillRef[] = [];
      const lookups: number[] = [];
      const members: Member[] = [];
      const window = past_hours ? `pastSeconds/${past_hours * 3600}/` : "";

      for (const u of urls ?? []) {
        const t = parseZkillUrl(u);
        if (t.kind === "related") throw new UserError(`${u} is a battle report: use doctrine_from_battle_report.`);
        if (t.kind === "kill") { lookups.push(t.id); continue; }
        const got = await ctx.zkill.list(t.apiPath + window, max);
        if (got.length >= max) notes.push(`${u}: read the newest ${max} killmails (max_kills).`);
        refs.push(...got);
        if (t.members) members.push({ ...t.members, name: (await ctx.resolver.entityName(t.members.id)) ?? `#${t.members.id}` });
      }

      const filterMembers = (
        await Promise.all([
          alliance ? resolveMember(alliance, "alliance_id") : null,
          corporation ? resolveMember(corporation, "corporation_id") : null,
          character ? resolveMember(character, "character_id") : null,
        ])
      ).filter((m): m is Member => m !== null);
      const shipId = ship ? typeRef(sde, ship) : undefined;
      if (filterMembers.length || shipId) {
        const parts = filterMembers.map((m) => `${ZKILL_FILTER[m.field]}/${m.id}/`).join("") + (shipId ? `shipTypeID/${shipId}/` : "");
        const got = await ctx.zkill.list(parts + (side && side !== "all" ? `${side}/` : "") + window, max);
        if (got.length >= max) notes.push(`Filters: read the newest ${max} killmails (max_kills).`);
        refs.push(...got);
        members.push(...filterMembers);
      }

      for (const k of killmails ?? []) {
        const r = parseKillRef(k);
        if (r.kind === "zkill") refs.push(r);
        else lookups.push(r.id);
      }
      if (lookups.length) refs.push(...(await ctx.zkill.hashesFor(unique(lookups).filter((id) => !refs.some((r) => r.id === id)))));
      if (!refs.length) {
        if (!urls?.length && !filterMembers.length && !shipId && !killmails?.length) {
          throw new UserError("Give zKillboard urls, a filter (alliance, corporation, character or ship) or killmails.");
        }
        throw new UserError("No killmails found for that input (check the ids and the time window).");
      }

      const { kms, failed } = await fetchKillmails(refs);
      if (failed) notes.push(`${failed} killmails could not be read from ESI.`);
      const override = members_of?.length ? await Promise.all(members_of.map((m) => resolveMember(m))) : null;
      const side_ = override ?? members;
      const isMember = side_.length ? isMemberOf(side_) : victimSide(kms);
      const who = side_.length ? unique(side_.map((m) => m.name)).join(", ") : "the victims' alliances/corporations";

      const kill_ids = unique(kms.map((k) => k.killmail_id)).sort((a, b) => b - a);
      const label = side_.length ? unique(side_.map((m) => m.name)).join(" + ") : shipId ? sde.typeName(shipId) : "Enemy";
      const draft = buildDoctrine(sde, {
        name: name ?? `${label} comp`,
        description: "",
        source: {
          type: "zkillboard",
          url: urls?.[0] ?? `${ZKILL_BASE}/kill/${kill_ids[0]}/`,
          kill_ids,
          fetched_at: new Date().toISOString(),
        },
        killmails: kms,
        isMember,
      });
      if (!draft.ships.length) throw new UserError(`None of the ${kms.length} killmails had pilots from ${who} in ships. Set members_of to the group you want.`);
      draft.description = [
        `From ${kms.length} zKillboard killmail${kms.length === 1 ? "" : "s"}, ${timeSpan(kms)}.`,
        `Pilots counted: ${who}${who.endsWith(".") ? "" : "."}`,
        compSummary(draft.ships) + ".",
        ...(urls && urls.length > 1 ? [`Sources: ${urls.join(", ")}.`] : []),
        ...notes,
      ].join(" ");
      return reply(draft satisfies DoctrineBundle, { raw: true });
    }),
  );

  server.registerTool(
    "doctrine_from_battle_report",
    {
      title: "Both sides' doctrines from a battle report",
      description:
        "Splits a fight into its two sides and builds a doctrine bundle for each: hulls with unique pilots per hull, EFTs of each " +
        "side's losses (modules + loaded charges) and the weapons seen. Input a zKillboard related URL " +
        "(zkillboard.com/related/<system>/<YYYYMMDDHH00>/), a br.evetools.org/related URL, or system + time. Returns " +
        "{sides: [bundle_A, bundle_B]}: pass each bundle unchanged to the eve-fit MCP's save_doctrine(**bundle). " +
        "For one group's losses over time use doctrine_from_killmails.",
      inputSchema: {
        url: z.string().optional().describe("e.g. 'https://zkillboard.com/related/30002053/202610262000/'."),
        system: z.string().optional().describe("Solar system of the fight, if no url, e.g. 'Huola'."),
        time: z.string().optional().describe("Fight time (UTC), if no url, e.g. '2026-10-27 09:00'. zKillboard covers the hour around it."),
        names: z.array(z.string()).length(2).optional().describe("Doctrine names for side A and side B (default from their biggest alliances)."),
        fits_per_hull: z.number().int().min(1).max(20).optional().describe("Losses read per hull and side for EFTs (default 5)."),
        max_kills: z.number().int().min(1).max(300).optional().describe("Cap on killmails read in total (default 150)."),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ url, system, time, names, fits_per_hull, max_kills }) => {
      const sde = await ctx.sde();
      let systemId: number;
      let when: string;
      if (url) {
        const t = parseZkillUrl(url);
        if (t.kind !== "related") throw new UserError(`${url} is not a battle report link; use a zkillboard.com/related/... or br.evetools.org/related/... URL, or doctrine_from_killmails.`);
        systemId = t.systemId;
        when = t.time;
      } else {
        if (!system || !time) throw new UserError("Give a battle report url, or system and time.");
        systemId = systemRef(sde, system);
        when = relatedTime(time);
      }
      const report = await ctx.zkill.related(systemId, when);
      const teams = [report.summary?.teamA?.list ?? [], report.summary?.teamB?.list ?? []];
      if (!teams[0].length && !teams[1].length) throw new UserError(`zKillboard has no kills around ${when} in ${sde.systemSummary(systemId)?.name ?? systemId}.`);

      // Losses to read: up to fits_per_hull per hull and side.
      const perHull = fits_per_hull ?? 5;
      const wanted: number[] = [];
      for (const team of teams) {
        const byHull = new Map<number, number[]>();
        for (const p of team) if (p.isVictim && p.killID) byHull.set(p.shipTypeID, [...(byHull.get(p.shipTypeID) ?? []), p.killID]);
        for (const ids of byHull.values()) wanted.push(...ids.slice(0, perHull));
      }
      const cap = max_kills ?? 150;
      const notes: string[] = [];
      if (wanted.length > cap) notes.push(`Read ${cap} of ${wanted.length} losses (max_kills).`);
      const refs = await ctx.zkill.hashesFor(unique(wanted).slice(0, cap));
      const { kms, failed } = await fetchKillmails(refs);
      if (failed || refs.length < Math.min(wanted.length, cap)) notes.push(`${Math.min(wanted.length, cap) - kms.length} losses could not be read.`);

      const all_kills = unique(teams.flat().filter((p) => p.isVictim && p.killID).map((p) => p.killID!)).sort((a, b) => b - a);
      const sourceUrl = url ?? `${ZKILL_BASE}/related/${systemId}/${when}/`;
      const sys = sde.systemSummary(systemId);
      const where = `${report.systemName ?? sys?.name ?? systemId}${sys ? ` (${sys.security}, ${sys.region})` : ""}`;
      const period = report.startTime && report.endTime ? `${report.startTime} to ${report.endTime} UTC` : `around ${when}`;

      const sides: DoctrineBundle[] = teams.map((team, i) => {
        const chars = new Set(team.map((p) => p.characterID).filter((id): id is number => !!id));
        const groups = topGroups(team);
        const bundle = buildDoctrine(sde, {
          name: names?.[i] ?? `${groups.join(" / ") || `Side ${"AB"[i]}`} @ ${report.systemName ?? sys?.name} ${when.slice(0, 8)}`,
          description: "",
          source: { type: "battle_report", url: sourceUrl, kill_ids: all_kills, fetched_at: new Date().toISOString() },
          killmails: kms,
          isMember: (p) => !!p.character_id && chars.has(p.character_id),
          roster: team.filter((p) => p.characterID).map((p) => ({ character_id: p.characterID!, ship_type_id: p.shipTypeID })),
          maxEftsPerHull: perHull,
        });
        const enemy = topGroups(teams[1 - i]).join(" / ");
        bundle.description = [
          `Side ${"AB"[i]} of the fight in ${where}, ${period}${enemy ? `, against ${enemy}` : ""}.`,
          `${chars.size} pilots, ${team.filter((p) => p.isVictim).length} losses.`,
          compSummary(bundle.ships) + ".",
          ...notes,
        ].join(" ");
        return bundle;
      });
      return reply({ sides }, { raw: true });
    }),
  );
}

/** The two biggest alliances (or corporations) on a team, by pilots. */
function topGroups(team: RelatedPilot[]): string[] {
  const counts = new Map<string, Set<number>>();
  for (const p of team) {
    const g = p.allianceName ?? p.corporationName;
    if (!g || !p.characterID) continue;
    if (!counts.has(g)) counts.set(g, new Set());
    counts.get(g)!.add(p.characterID);
  }
  return [...counts.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 2).map(([g]) => g);
}
