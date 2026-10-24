/** Logs to stderr; stdout belongs to the MCP stdio transport. */
export function log(...args: unknown[]) {
  console.error("[eve-esi-mcp]", ...args);
}

export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function unique<T>(arr: Iterable<T>): T[] {
  return [...new Set(arr)];
}

/** Runs `fn` over items with bounded concurrency, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export function isk(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  const abs = Math.abs(n);
  const fmt = (v: number, s: string) => `${(n < 0 ? -v : v).toFixed(2)}${s} ISK`;
  if (abs >= 1e12) return fmt(abs / 1e12, "t");
  if (abs >= 1e9) return fmt(abs / 1e9, "b");
  if (abs >= 1e6) return fmt(abs / 1e6, "m");
  if (abs >= 1e3) return fmt(abs / 1e3, "k");
  return `${n.toFixed(2)} ISK`;
}

export function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function duration(ms: number): string {
  if (ms <= 0) return "0s";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m && d === 0) parts.push(`${m}m`);
  if (!parts.length) parts.push(`${s % 60}s`);
  return parts.join(" ");
}

/** Normalises a name for loose matching. */
export function norm(s: string): string {
  return s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
}

/** Drops null/undefined fields and empty arrays so responses stay compact. */
export function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(compact) as T;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      out[k] = compact(v);
    }
    return out as T;
  }
  return value;
}

export function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<a href="?showinfo:\d+\/\/(\d+)"?>(.*?)<\/a>/gi, "$2")
    .replace(/<[^>]+>/g, "")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
