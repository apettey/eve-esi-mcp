import { ATTR, CATEGORY, type Sde } from "../sde/db.js";
import { UserError, norm } from "../util.js";

export type SlotKind = "high" | "med" | "low" | "rig" | "subsystem" | "service";
export const SLOT_ORDER_EFT: SlotKind[] = ["low", "med", "high", "rig", "subsystem", "service"];

export interface FittedModule {
  type_id: number;
  charge_type_id?: number;
  charge_quantity?: number;
  offline?: boolean;
}

/** A ship fitting independent of where it came from (saved fitting, assets, killmail, EFT). */
export interface Fit {
  name: string;
  description?: string;
  ship_type_id: number;
  slots: Record<SlotKind, Array<FittedModule | null>>;
  drones: Array<{ type_id: number; quantity: number }>;
  fighters: Array<{ type_id: number; quantity: number }>;
  cargo: Array<{ type_id: number; quantity: number }>;
  implants: number[];
}

const SLOT_PREFIX: Record<string, SlotKind> = {
  HiSlot: "high",
  MedSlot: "med",
  LoSlot: "low",
  RigSlot: "rig",
  SubSystemSlot: "subsystem",
  ServiceSlot: "service",
};

const ESI_PREFIX: Record<SlotKind, string> = {
  high: "HiSlot",
  med: "MedSlot",
  low: "LoSlot",
  rig: "RigSlot",
  subsystem: "SubSystemSlot",
  service: "ServiceSlot",
};

/** Killmail/inventory numeric flags -> ESI string flags. */
export function numericFlagToName(flag: number): string {
  const range = (start: number, prefix: string) => (flag >= start && flag < start + 8 ? `${prefix}${flag - start}` : null);
  return (
    range(11, "LoSlot") ?? range(19, "MedSlot") ?? range(27, "HiSlot") ?? range(92, "RigSlot") ??
    range(125, "SubSystemSlot") ?? range(164, "ServiceSlot") ??
    ({ 5: "Cargo", 87: "DroneBay", 89: "Implant", 158: "FighterBay" } as Record<number, string>)[flag] ??
    (flag >= 159 && flag <= 163 ? "FighterTube" : "Cargo")
  );
}

export function parseSlotFlag(flag: string): { kind: SlotKind; index: number } | null {
  const m = /^(HiSlot|MedSlot|LoSlot|RigSlot|SubSystemSlot|ServiceSlot)(\d+)$/.exec(flag);
  return m ? { kind: SLOT_PREFIX[m[1]], index: Number(m[2]) } : null;
}

function emptyFit(name: string, shipTypeId: number): Fit {
  return {
    name,
    ship_type_id: shipTypeId,
    slots: { high: [], med: [], low: [], rig: [], subsystem: [], service: [] },
    drones: [],
    fighters: [],
    cargo: [],
    implants: [],
  };
}

function addStack(list: Array<{ type_id: number; quantity: number }>, typeId: number, qty: number) {
  const e = list.find((x) => x.type_id === typeId);
  if (e) e.quantity += qty;
  else list.push({ type_id: typeId, quantity: qty });
}

/**
 * Builds a Fit from flagged items (ESI saved fittings, asset contents, killmail items).
 * Charges sharing a slot flag with a module are treated as that module's loaded charge.
 */
export function fitFromFlaggedItems(
  sde: Sde,
  name: string,
  shipTypeId: number,
  items: Array<{ type_id: number; flag: string; quantity: number }>,
  description?: string,
): Fit {
  const fit = emptyFit(name, shipTypeId);
  fit.description = description;
  const charges: Array<{ kind: SlotKind; index: number; type_id: number; quantity: number }> = [];
  for (const it of items) {
    const slot = parseSlotFlag(it.flag);
    const cat = sde.type(it.type_id)?.category_id;
    if (slot) {
      if (cat === CATEGORY.charge) {
        charges.push({ ...slot, type_id: it.type_id, quantity: it.quantity });
      } else {
        fit.slots[slot.kind][slot.index] = { type_id: it.type_id };
      }
    } else if (it.flag === "DroneBay") addStack(fit.drones, it.type_id, it.quantity);
    else if (it.flag === "FighterBay" || it.flag.startsWith("FighterTube")) addStack(fit.fighters, it.type_id, it.quantity);
    else if (it.flag === "Implant") fit.implants.push(it.type_id);
    else if (it.flag !== "Invalid") addStack(fit.cargo, it.type_id, it.quantity);
  }
  for (const c of charges) {
    const m = fit.slots[c.kind][c.index];
    if (m) { m.charge_type_id = c.type_id; m.charge_quantity = c.quantity; }
    else addStack(fit.cargo, c.type_id, c.quantity);
  }
  // Fill holes so slot indices are preserved.
  for (const k of Object.keys(fit.slots) as SlotKind[]) {
    fit.slots[k] = Array.from({ length: fit.slots[k].length }, (_, i) => fit.slots[k][i] ?? null);
  }
  return fit;
}

export function shipSlotCounts(sde: Sde, shipTypeId: number, fit?: Fit): Record<SlotKind, number> {
  const a = sde.typeAttributes(shipTypeId);
  const counts: Record<SlotKind, number> = {
    high: a.get(ATTR.hiSlots) ?? 0,
    med: a.get(ATTR.medSlots) ?? 0,
    low: a.get(ATTR.lowSlots) ?? 0,
    rig: a.get(ATTR.rigSlots) ?? 0,
    subsystem: a.get(ATTR.subsystemSlots) ?? 0,
    service: a.get(2056) ?? 0,
  };
  // Strategic cruisers get their slots from subsystems.
  if (fit) {
    for (const m of fit.slots.subsystem) {
      if (!m) continue;
      const sa = sde.typeAttributes(m.type_id);
      counts.high += sa.get(1374) ?? 0;
      counts.med += sa.get(1375) ?? 0;
      counts.low += sa.get(1376) ?? 0;
    }
  }
  return counts;
}

const EMPTY_LABEL: Record<SlotKind, string> = {
  high: "[Empty High slot]",
  med: "[Empty Med slot]",
  low: "[Empty Low slot]",
  rig: "[Empty Rig slot]",
  subsystem: "[Empty Subsystem slot]",
  service: "[Empty Service slot]",
};

/** Serialises a fit to EFT, the format used by the in-game "Import from Clipboard" and tools like Pyfa. */
export function toEft(sde: Sde, fit: Fit, opts: { includeEmpty?: boolean } = {}): string {
  const counts = shipSlotCounts(sde, fit.ship_type_id, fit);
  const lines: string[] = [`[${sde.typeName(fit.ship_type_id)}, ${fit.name.replace(/[\[\]]/g, "")}]`];
  const sections: string[][] = [];
  for (const kind of SLOT_ORDER_EFT) {
    const total = Math.max(counts[kind], fit.slots[kind].length);
    if (!total) continue;
    const sec: string[] = [];
    for (let i = 0; i < total; i++) {
      const m = fit.slots[kind][i];
      if (m) {
        let line = sde.typeName(m.type_id);
        if (m.charge_type_id) line += `, ${sde.typeName(m.charge_type_id)}`;
        if (m.offline) line += " /offline";
        sec.push(line);
      } else if (opts.includeEmpty !== false && i < counts[kind]) {
        sec.push(EMPTY_LABEL[kind]);
      }
    }
    if (sec.length) sections.push(sec);
  }
  lines.push(sections.map((s) => s.join("\n")).join("\n\n"));
  const stack = (l: Array<{ type_id: number; quantity: number }>) => l.map((x) => `${sde.typeName(x.type_id)} x${x.quantity}`).join("\n");
  const tail = [stack(fit.drones), stack(fit.fighters), fit.implants.map((i) => sde.typeName(i)).join("\n"), stack(fit.cargo)].filter(Boolean);
  let out = lines.join("\n");
  for (const t of tail) out += "\n\n\n" + t;
  return out + "\n";
}

/** Ship DNA, as used by in-game fitting links: <url=fitting:DNA>name</url>. */
export function toDna(fit: Fit): string {
  const counts = new Map<number, number>();
  const order: number[] = [];
  const add = (id: number, n: number) => {
    if (!counts.has(id)) order.push(id);
    counts.set(id, (counts.get(id) ?? 0) + n);
  };
  for (const kind of ["subsystem", "high", "med", "low", "rig", "service"] as SlotKind[]) {
    for (const m of fit.slots[kind]) if (m) add(m.type_id, 1);
  }
  for (const d of [...fit.drones, ...fit.fighters]) add(d.type_id, d.quantity);
  const charges = new Map<number, number>();
  for (const kind of Object.keys(fit.slots) as SlotKind[]) {
    for (const m of fit.slots[kind]) if (m?.charge_type_id) charges.set(m.charge_type_id, (charges.get(m.charge_type_id) ?? 0) + 1);
  }
  for (const c of fit.cargo) charges.set(c.type_id, (charges.get(c.type_id) ?? 0) + c.quantity);
  const parts = order.map((id) => `${id};${counts.get(id)}`);
  for (const [id, n] of charges) parts.push(`${id};${n}`);
  return `${fit.ship_type_id}:${parts.join(":")}::`;
}

/** Converts a Fit back into ESI's saved-fitting item list. Loaded charges go to cargo (ESI cannot store them per slot). */
export function toEsiItems(fit: Fit): Array<{ type_id: number; flag: string; quantity: number }> {
  const items: Array<{ type_id: number; flag: string; quantity: number }> = [];
  for (const kind of Object.keys(fit.slots) as SlotKind[]) {
    fit.slots[kind].forEach((m, i) => {
      if (m) items.push({ type_id: m.type_id, flag: `${ESI_PREFIX[kind]}${i}`, quantity: 1 });
    });
  }
  for (const d of fit.drones) items.push({ type_id: d.type_id, flag: "DroneBay", quantity: d.quantity });
  for (const f of fit.fighters) items.push({ type_id: f.type_id, flag: "FighterBay", quantity: f.quantity });
  for (const c of fit.cargo) items.push({ type_id: c.type_id, flag: "Cargo", quantity: c.quantity });
  return items;
}

export interface EftParseResult {
  fit: Fit;
  warnings: string[];
}

/** Parses EFT text. Names are matched against the SDE (case-insensitive, English). */
export function parseEft(sde: Sde, text: string): EftParseResult {
  const lines = text.replace(/\r/g, "").split("\n");
  const warnings: string[] = [];
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const header = /^\[(.+?)(?:,\s*(.*))?\]\s*$/.exec(lines[i]?.trim() ?? "");
  if (!header) throw new UserError("EFT text must start with a header line like `[Rifter, My Fit]`.");
  const shipId = resolveTypeName(sde, header[1]);
  if (!shipId) throw new UserError(`Unknown ship type "${header[1]}".`);
  const fit = emptyFit(header[2]?.trim() || "Imported fit", shipId);
  const counts = shipSlotCounts(sde, shipId);

  for (i++; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line || /^\[empty .* slot\]$/i.test(line)) continue;
    let offline = false;
    if (/\s*\/offline$/i.test(line)) { offline = true; line = line.replace(/\s*\/offline$/i, ""); }
    let qty = 1;
    let hasQty = false;
    const q = /^(.*?)\s+x\s?([\d,]+)$/i.exec(line);
    if (q) { line = q[1].trim(); qty = Number(q[2].replace(/,/g, "")); hasQty = true; }
    const [modName, chargeName] = line.split(/,\s*/, 2);
    const typeId = resolveTypeName(sde, modName);
    if (!typeId) { warnings.push(`Unknown item "${modName}" skipped.`); continue; }
    const t = sde.type(typeId)!;
    if (t.category_id === CATEGORY.drone) { addStack(fit.drones, typeId, qty); continue; }
    if (t.category_id === CATEGORY.fighter) { addStack(fit.fighters, typeId, qty); continue; }
    if (t.category_id === CATEGORY.implant && !hasQty) { fit.implants.push(typeId); continue; }
    const slot = t.slot as SlotKind | null;
    if (slot && !hasQty) {
      const arr = fit.slots[slot];
      if (slot !== "subsystem" && counts[slot] && arr.length >= counts[slot] && fit.slots.subsystem.length === 0) {
        warnings.push(`${t.name}: more ${slot} modules than the hull has slots.`);
      }
      const mod: FittedModule = { type_id: typeId };
      if (offline) mod.offline = true;
      if (chargeName) {
        const chargeId = resolveTypeName(sde, chargeName);
        if (chargeId) mod.charge_type_id = chargeId;
        else warnings.push(`Unknown charge "${chargeName}" skipped.`);
      }
      arr.push(mod);
      continue;
    }
    addStack(fit.cargo, typeId, qty);
  }
  return { fit, warnings };
}

export function resolveTypeName(sde: Sde, name: string): number | null {
  const n = name.trim();
  if (!n) return null;
  const exact = sde.typeIdByName(n);
  if (exact) return exact;
  const hits = sde.searchTypes(n, { limit: 1 });
  return hits.length && hits[0].score >= 900 ? hits[0].id : null;
}

export function sameName(a: string, b: string) {
  return norm(a) === norm(b);
}
