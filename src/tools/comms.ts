import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Ctx } from "../context.js";
import { fitFromFlaggedItems, numericFlagToName, toEft } from "../fit/model.js";
import { UserError, mapLimit, round, stripHtml } from "../util.js";
import { READ_ONLY, characterParam, handler, reply } from "./helpers.js";

/** Notification `text` is YAML; this flat parse covers the common `key: value` fields. */
function parseNotificationText(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (text ?? "").split("\n")) {
    const m = /^([A-Za-z_][\w]*):\s*(.*)$/.exec(line.trim());
    if (m && m[2] !== "") out[m[1]] = m[2].replace(/^&id\d+\s*/, "").replace(/^['"]|['"]$/g, "");
  }
  return out;
}

const TYPE_FIELDS = /typeID$/i;
/** Any other *ID field with a plausible id is resolved generically (characters, corps, stations, systems, ...). */
const ID_FIELD = /ID$/;
const isResolvableId = (v: string) => /^\d+$/.test(v) && Number(v) > 0 && Number(v) < 1e12;

export function registerCommsTools(server: McpServer, ctx: Ctx) {
  server.registerTool(
    "mail_list",
    {
      title: "List EVE mail",
      description: "Recent EVE mail headers with sender/recipient names, labels and read state. Use mail_read for bodies.",
      inputSchema: {
        character: characterParam,
        unread_only: z.boolean().optional(),
        label: z.string().optional().describe("Only mails with this label name (e.g. 'Inbox', 'Sent', 'Corp', 'Alliance')."),
        limit: z.number().int().min(1).max(200).optional().describe("Default 25."),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ character, unread_only, label, limit }) => {
      const c = ctx.character(character);
      const scope = "esi-mail.read_mail.v1";
      const labels = await ctx.esi.get<any>(`/characters/${c.id}/mail/labels`, { character: c, scope });
      const labelMap = new Map<number, string>((labels.labels ?? []).map((l: any) => [l.label_id, l.name]));
      const labelId = label ? [...labelMap.entries()].find(([, n]) => n.toLowerCase() === label.toLowerCase())?.[0] : undefined;
      if (label && labelId == null) throw new UserError(`Unknown mail label "${label}". Labels: ${[...labelMap.values()].join(", ")}`);
      const mails: any[] = [];
      let lastId: number | undefined;
      // Mail is paged by last_mail_id, 50 per call.
      while (mails.length < (limit ?? 25) * (unread_only ? 4 : 1)) {
        const page = await ctx.esi.get<any[]>(`/characters/${c.id}/mail`, {
          character: c, scope, query: { labels: labelId != null ? [labelId] : undefined, last_mail_id: lastId },
        });
        mails.push(...page);
        if (page.length < 50) break;
        lastId = page.at(-1).mail_id;
        if (mails.length >= 500) break;
      }
      const list = mails.filter((m) => !unread_only || !m.is_read).slice(0, limit ?? 25);
      const lists = await ctx.esi.get<any[]>(`/characters/${c.id}/mail/lists`, { character: c }).catch(() => []);
      const listNames = new Map(lists.map((l) => [l.mailing_list_id, l.name]));
      const names = await ctx.resolver.entities(list.flatMap((m) => [m.from, ...(m.recipients ?? []).filter((r: any) => r.recipient_type !== "mailing_list").map((r: any) => r.recipient_id)]));
      return reply({
        character: c.name,
        unread_total: labels.total_unread_count,
        mails: list.map((m) => ({
          mail_id: m.mail_id,
          from: names.get(m.from)?.name ?? listNames.get(m.from) ?? m.from,
          subject: m.subject,
          date: m.timestamp,
          read: !!m.is_read,
          to: (m.recipients ?? []).map((r: any) => names.get(r.recipient_id)?.name ?? listNames.get(r.recipient_id) ?? r.recipient_id),
          labels: (m.labels ?? []).map((l: number) => labelMap.get(l) ?? l),
        })),
      });
    }),
  );

  server.registerTool(
    "mail_read",
    {
      title: "Read EVE mail",
      description: "Full text of one or more mails (HTML converted to plain text) with sender and recipient names.",
      inputSchema: {
        mail_ids: z.array(z.number().int()).min(1).max(10),
        character: characterParam,
      },
      annotations: READ_ONLY,
    },
    handler(async ({ mail_ids, character }) => {
      const c = ctx.character(character);
      const mails = await mapLimit(mail_ids, 5, (id) =>
        ctx.esi.get<any>(`/characters/${c.id}/mail/${id}`, { character: c, scope: "esi-mail.read_mail.v1" }).then((m) => ({ id, ...m })),
      );
      const names = await ctx.resolver.entities(mails.flatMap((m) => [m.from, ...(m.recipients ?? []).map((r: any) => r.recipient_id)]));
      return reply({
        character: c.name,
        mails: mails.map((m) => ({
          mail_id: m.id,
          from: names.get(m.from)?.name ?? m.from,
          to: (m.recipients ?? []).map((r: any) => names.get(r.recipient_id)?.name ?? r.recipient_id),
          subject: m.subject,
          date: m.timestamp,
          body: stripHtml(m.body ?? ""),
        })),
      });
    }),
  );

  server.registerTool(
    "mail_send",
    {
      title: "Send EVE mail",
      description:
        "Sends an in-game EVE mail from the character. Recipients are names of characters, corporations, alliances or the character's " +
        "mailing lists. This sends a real message: always confirm recipients, subject and body with the user first.",
      inputSchema: {
        to: z.array(z.string()).min(1).max(50).describe("Recipient names."),
        subject: z.string().min(1).max(1000),
        body: z.string().min(1).max(10000).describe("Plain text; newlines are preserved."),
        character: characterParam,
      },
      annotations: { openWorldHint: true, destructiveHint: false },
    },
    handler(async ({ to, subject, body, character }) => {
      const c = ctx.character(character);
      ctx.esi.requireScope(c, "esi-mail.send_mail.v1");
      const ids = await ctx.esi.post<Record<string, Array<{ id: number; name: string }>>>("/universe/ids", to);
      const lists = await ctx.esi.get<any[]>(`/characters/${c.id}/mail/lists`, { character: c, scope: "esi-mail.read_mail.v1" }).catch(() => []);
      const recipients: Array<{ recipient_id: number; recipient_type: string }> = [];
      const missing: string[] = [];
      for (const name of to) {
        const lower = name.toLowerCase();
        const find = (k: string) => ids[k]?.find((e) => e.name.toLowerCase() === lower);
        const ch = find("characters"), co = find("corporations"), al = find("alliances");
        const ml = lists.find((l: any) => l.name.toLowerCase() === lower);
        if (ch) recipients.push({ recipient_id: ch.id, recipient_type: "character" });
        else if (co) recipients.push({ recipient_id: co.id, recipient_type: "corporation" });
        else if (al) recipients.push({ recipient_id: al.id, recipient_type: "alliance" });
        else if (ml) recipients.push({ recipient_id: ml.mailing_list_id, recipient_type: "mailing_list" });
        else missing.push(name);
      }
      if (missing.length) throw new UserError(`Could not resolve recipients: ${missing.join(", ")}. Nothing was sent.`);
      const html = body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
      const mailId = await ctx.esi.post<number>(`/characters/${c.id}/mail`, { recipients, subject, body: html, approved_cost: 0 }, { character: c });
      return reply({ sent: true, mail_id: mailId, from: c.name, to, subject });
    }),
  );

  server.registerTool(
    "notifications",
    {
      title: "Character notifications",
      description:
        "Recent in-game notifications (structure attacks, war declarations, kill reports, sov, corp applications, ...) with the YAML " +
        "payload parsed and ids resolved to names. Filter by type substring (e.g. 'Structure', 'War', 'Kill').",
      inputSchema: {
        character: characterParam,
        type_filter: z.string().optional().describe("Only notification types containing this text."),
        unread_only: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional().describe("Default 30."),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ character, type_filter, unread_only, limit }) => {
      const c = ctx.character(character);
      const sde = await ctx.sde();
      const all = await ctx.esi.get<any[]>(`/characters/${c.id}/notifications`, { character: c, scope: "esi-characters.read_notifications.v1" });
      const f = type_filter?.toLowerCase();
      const list = all
        .filter((n) => (!f || n.type.toLowerCase().includes(f)) && (!unread_only || !n.is_read))
        .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
        .slice(0, limit ?? 30);
      const parsed = list.map((n) => ({ n, fields: parseNotificationText(n.text) }));
      const entityIds = new Set<number>();
      for (const { n, fields } of parsed) {
        entityIds.add(n.sender_id);
        for (const [k, v] of Object.entries(fields)) if (ID_FIELD.test(k) && !TYPE_FIELDS.test(k) && isResolvableId(v)) entityIds.add(Number(v));
      }
      const names = await ctx.resolver.entities(entityIds);
      return reply({
        character: c.name,
        total: all.length,
        notifications: parsed.map(({ n, fields }) => {
          const details: Record<string, string> = {};
          for (const [k, v] of Object.entries(fields)) {
            const num = isResolvableId(v) ? Number(v) : null;
            const label = k.replace(/ID$/, "");
            if (num != null && TYPE_FIELDS.test(k)) details[label] = sde.typeName(num);
            else if (num != null && ID_FIELD.test(k) && names.has(num)) details[label] = names.get(num)!.name;
            else details[k] = v.length > 200 ? v.slice(0, 200) + "…" : v;
          }
          return {
            type: n.type,
            date: n.timestamp,
            read: !!n.is_read,
            sender: names.get(n.sender_id)?.name ?? n.sender_type,
            details,
          };
        }),
      });
    }),
  );

  server.registerTool(
    "killmails",
    {
      title: "Recent kills and losses",
      description:
        "A character's recent killmails with victim/attacker names, ships, system and security, and zKillboard links. " +
        "For losses (or any kill with include_fit) the victim's fit is rebuilt as EFT with dropped/destroyed items.",
      inputSchema: {
        character: characterParam,
        filter: z.enum(["all", "kills", "losses"]).optional(),
        limit: z.number().int().min(1).max(50).optional().describe("Default 10."),
        include_fit: z.boolean().optional().describe("Include EFT of the victim's ship for every killmail (losses always include it)."),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ character, filter, limit, include_fit }) => {
      const c = ctx.character(character);
      const sde = await ctx.sde();
      const recent = await ctx.esi.get<Array<{ killmail_id: number; killmail_hash: string }>>(`/characters/${c.id}/killmails/recent`, {
        character: c, scope: "esi-killmails.read_killmails.v1",
      });
      const kms = await mapLimit(recent.slice(0, Math.min(100, (limit ?? 10) * 3)), 8, (k) =>
        ctx.esi.get<any>(`/killmails/${k.killmail_id}/${k.killmail_hash}`).then((d) => d).catch(() => null),
      );
      const list = kms
        .filter(Boolean)
        .filter((k) => {
          const loss = k.victim.character_id === c.id;
          return !filter || filter === "all" || (filter === "losses" ? loss : !loss);
        })
        .sort((a, b) => Date.parse(b.killmail_time) - Date.parse(a.killmail_time))
        .slice(0, limit ?? 10);
      const names = await ctx.resolver.entities(list.flatMap((k) => [
        k.victim.character_id, k.victim.corporation_id, k.victim.alliance_id,
        ...k.attackers.flatMap((a: any) => [a.character_id, a.corporation_id]),
      ]).filter(Boolean));
      const nm = (id?: number) => (id ? names.get(id)?.name : undefined);
      return reply({
        character: c.name,
        killmails: list.map((k) => {
          const loss = k.victim.character_id === c.id;
          const final = k.attackers.find((a: any) => a.final_blow);
          const me = k.attackers.find((a: any) => a.character_id === c.id);
          const sys = sde.systemSummary(k.solar_system_id);
          let fit: string | undefined;
          let dropped: string[] | undefined;
          if ((loss || include_fit) && k.victim.items?.length) {
            const items = (k.victim.items ?? []).map((i: any) => ({
              type_id: i.item_type_id,
              flag: numericFlagToName(i.flag),
              quantity: (i.quantity_destroyed ?? 0) + (i.quantity_dropped ?? 0) || 1,
            }));
            fit = toEft(sde, fitFromFlaggedItems(sde, `Killmail ${k.killmail_id}`, k.victim.ship_type_id, items));
            dropped = (k.victim.items ?? []).filter((i: any) => i.quantity_dropped).map((i: any) => `${sde.typeName(i.item_type_id)} x${i.quantity_dropped}`);
          }
          return {
            result: loss ? "loss" : "kill",
            time: k.killmail_time,
            system: sys ? `${sys.name} (${sys.security}, ${sys.region})` : k.solar_system_id,
            victim: {
              character: nm(k.victim.character_id),
              corporation: nm(k.victim.corporation_id),
              alliance: nm(k.victim.alliance_id),
              ship: sde.typeName(k.victim.ship_type_id),
              damage_taken: k.victim.damage_taken,
            },
            attackers: k.attackers.length,
            final_blow: final ? `${nm(final.character_id) ?? "NPC"} (${final.ship_type_id ? sde.typeName(final.ship_type_id) : "?"})` : undefined,
            my_role: me ? { ship: me.ship_type_id ? sde.typeName(me.ship_type_id) : undefined, weapon: me.weapon_type_id ? sde.typeName(me.weapon_type_id) : undefined, damage: me.damage_done, final_blow: me.final_blow } : undefined,
            top_damage: k.attackers
              .slice()
              .sort((a: any, b: any) => b.damage_done - a.damage_done)
              .slice(0, 3)
              .map((a: any) => `${nm(a.character_id) ?? "NPC"} ${a.ship_type_id ? sde.typeName(a.ship_type_id) : ""} ${round((a.damage_done / Math.max(1, k.victim.damage_taken)) * 100, 1)}%`),
            zkillboard: `https://zkillboard.com/kill/${k.killmail_id}/`,
            fit,
            dropped,
          };
        }),
      });
    }),
  );
}
