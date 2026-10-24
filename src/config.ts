import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as { version: string };

export const VERSION = pkg.version;

/** ESI behaviour this server was written against. Bump after reviewing /meta/changelog. */
export const COMPATIBILITY_DATE = "2026-08-18";

export const ESI_BASE = "https://esi.evetech.net";
export const SSO_METADATA_URL = "https://login.eveonline.com/.well-known/oauth-authorization-server";
export const SDE_LATEST_URL = "https://developers.eveonline.com/static-data/tranquility/latest.jsonl";
export const SDE_ZIP_URL = (build: number) =>
  `https://developers.eveonline.com/static-data/tranquility/eve-online-static-data-${build}-jsonl.zip`;

export interface Config {
  home: string;
  clientId?: string;
  clientSecret?: string;
  callbackUrl: string;
  userAgent: string;
  defaultScopes?: string[];
  openBrowser: boolean;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

export function loadConfig(): Config {
  const home = env("EVE_ESI_MCP_HOME") ?? join(homedir(), ".eve-esi-mcp");
  mkdirSync(home, { recursive: true });
  const contact = env("EVE_CONTACT");
  return {
    home,
    clientId: env("EVE_CLIENT_ID"),
    clientSecret: env("EVE_CLIENT_SECRET"),
    callbackUrl: env("EVE_CALLBACK_URL") ?? "http://localhost:8642/callback",
    userAgent:
      `eve-esi-mcp/${VERSION} (${contact ? contact + "; " : ""}+https://github.com/apettey/eve-esi-mcp)`,
    defaultScopes: env("EVE_SCOPES")?.split(/[\s,]+/).filter(Boolean),
    openBrowser: env("EVE_OPEN_BROWSER") !== "false",
  };
}

/** Major trade hubs, used as defaults for market tools. */
export const TRADE_HUBS: Record<string, { stationId: number; systemId: number; regionId: number; name: string }> = {
  jita: { stationId: 60003760, systemId: 30000142, regionId: 10000002, name: "Jita IV - Moon 4 - Caldari Navy Assembly Plant" },
  amarr: { stationId: 60008494, systemId: 30002187, regionId: 10000043, name: "Amarr VIII (Oris) - Emperor Family Academy" },
  dodixie: { stationId: 60011866, systemId: 30002659, regionId: 10000032, name: "Dodixie IX - Moon 20 - Federation Navy Assembly Plant" },
  rens: { stationId: 60004588, systemId: 30002510, regionId: 10000030, name: "Rens VI - Moon 8 - Brutor Tribe Treasury" },
  hek: { stationId: 60005686, systemId: 30002053, regionId: 10000042, name: "Hek VIII - Moon 12 - Boundless Creation Factory" },
};
