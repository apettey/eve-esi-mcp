import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { SSO_METADATA_URL, type Config } from "../config.js";
import { UserError, log } from "../util.js";
import type { CharacterStore, StoredCharacter } from "./store.js";

interface SsoMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  revocation_endpoint: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
}

interface PendingLogin {
  state: string;
  verifier: string;
  scopes: string[];
  url: string;
  createdAt: number;
  promise: Promise<StoredCharacter>;
  resolve: (c: StoredCharacter) => void;
  reject: (e: Error) => void;
}

const LOGIN_TTL_MS = 10 * 60 * 1000;
const REFRESH_MARGIN_MS = 60 * 1000;

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** EVE SSO (OAuth2 authorization code + PKCE) with a loopback callback listener. */
export class Sso {
  private metadata?: { value: SsoMetadata; at: number };
  private jwks?: ReturnType<typeof createRemoteJWKSet>;
  private pending = new Map<string, PendingLogin>();
  private server?: Server;
  private refreshing = new Map<number, Promise<string>>();

  constructor(private cfg: Config, private store: CharacterStore) {}

  get configured(): boolean {
    return !!this.cfg.clientId;
  }

  private requireClient(): string {
    if (!this.cfg.clientId) {
      throw new UserError(
        "EVE_CLIENT_ID is not set. Register an application at https://developers.eveonline.com/applications " +
          `with callback URL ${this.cfg.callbackUrl}, then set EVE_CLIENT_ID (and optionally EVE_CLIENT_SECRET) in the MCP server environment.`,
      );
    }
    return this.cfg.clientId;
  }

  private async meta(): Promise<SsoMetadata> {
    if (this.metadata && Date.now() - this.metadata.at < 3600_000) return this.metadata.value;
    const res = await fetch(SSO_METADATA_URL, { headers: { "User-Agent": this.cfg.userAgent } });
    if (!res.ok) throw new Error(`SSO metadata request failed: HTTP ${res.status}`);
    const value = (await res.json()) as SsoMetadata;
    this.metadata = { value, at: Date.now() };
    this.jwks = createRemoteJWKSet(new URL(value.jwks_uri));
    return value;
  }

  private async tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
    const clientId = this.requireClient();
    const { token_endpoint } = await this.meta();
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": this.cfg.userAgent,
    };
    const body = new URLSearchParams(params);
    if (this.cfg.clientSecret) {
      headers.Authorization = "Basic " + Buffer.from(`${clientId}:${this.cfg.clientSecret}`).toString("base64");
    } else {
      body.set("client_id", clientId);
    }
    const res = await fetch(token_endpoint, { method: "POST", headers, body });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`SSO token request failed: HTTP ${res.status} ${text.slice(0, 300)}`);
      (err as any).status = res.status;
      (err as any).body = text;
      throw err;
    }
    return JSON.parse(text) as TokenResponse;
  }

  private async verify(accessToken: string): Promise<JWTPayload & { name: string; owner: string; scp?: string | string[] }> {
    await this.meta();
    const { payload } = await jwtVerify(accessToken, this.jwks!, {
      issuer: ["login.eveonline.com", "https://login.eveonline.com"],
      audience: "EVE Online",
    });
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(this.cfg.clientId!)) throw new Error("Access token audience does not match EVE_CLIENT_ID");
    return payload as any;
  }

  private async characterFromTokens(tokens: TokenResponse): Promise<StoredCharacter> {
    const claims = await this.verify(tokens.access_token);
    const id = Number(String(claims.sub).split(":").pop());
    const scp = claims.scp == null ? [] : Array.isArray(claims.scp) ? claims.scp : [claims.scp];
    return {
      id,
      name: claims.name,
      owner_hash: claims.owner,
      scopes: scp,
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token,
      expires_at: Date.now() + tokens.expires_in * 1000,
      added_at: new Date().toISOString(),
    };
  }

  // ---------- login flow ----------

  async startLogin(scopes: string[]): Promise<PendingLogin> {
    const clientId = this.requireClient();
    const { authorization_endpoint } = await this.meta();
    await this.ensureServer();
    const state = b64url(randomBytes(16));
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const url = new URL(authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      redirect_uri: this.cfg.callbackUrl,
      client_id: clientId,
      scope: scopes.join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    let resolve!: (c: StoredCharacter) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<StoredCharacter>((res, rej) => { resolve = res; reject = rej; });
    promise.catch(() => {}); // callers may not await; avoid unhandled rejections
    const p: PendingLogin = { state, verifier, scopes, url: url.toString(), createdAt: Date.now(), promise, resolve, reject };
    this.pending.set(state, p);
    setTimeout(() => {
      if (this.pending.delete(state)) {
        reject(new Error("Login timed out"));
        this.maybeCloseServer();
      }
    }, LOGIN_TTL_MS).unref();
    return p;
  }

  openBrowser(url: string): boolean {
    if (!this.cfg.openBrowser) return false;
    try {
      const [cmd, args] =
        process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : process.platform === "darwin" ? ["open", [url]]
        : ["xdg-open", [url]];
      const child = spawn(cmd as string, args as string[], { detached: true, stdio: "ignore" });
      child.on("error", () => {});
      child.unref();
      return true;
    } catch {
      return false;
    }
  }

  private async ensureServer() {
    if (this.server) return;
    const cb = new URL(this.cfg.callbackUrl);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(cb.hostname)) {
      throw new UserError(`EVE_CALLBACK_URL must point at localhost for the built-in listener (got ${cb.hostname}).`);
    }
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", this.cfg.callbackUrl);
      if (url.pathname !== cb.pathname) {
        res.writeHead(404).end("Not found");
        return;
      }
      const state = url.searchParams.get("state") ?? "";
      const code = url.searchParams.get("code");
      const p = this.pending.get(state);
      if (!p || !code) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(page("Login failed", "Unknown or expired login request. Start the login again from your AI assistant."));
        return;
      }
      this.pending.delete(state);
      try {
        const tokens = await this.tokenRequest({ grant_type: "authorization_code", code, code_verifier: p.verifier });
        const character = await this.characterFromTokens(tokens);
        this.store.upsert(character);
        res.writeHead(200, { "Content-Type": "text/html" }).end(
          page("Character authorized", `<b>${escapeHtml(character.name)}</b> is now available to your AI assistant. You can close this tab.`),
        );
        p.resolve(character);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/html" }).end(page("Login failed", escapeHtml((err as Error).message)));
        p.reject(err as Error);
      } finally {
        this.maybeCloseServer();
      }
    });
    const port = Number(cb.port || 80);
    await new Promise<void>((resolve, reject) => {
      server.once("error", (err: NodeJS.ErrnoException) =>
        reject(err.code === "EADDRINUSE"
          ? new UserError(`Callback port ${port} is in use. Close the other process or change EVE_CALLBACK_URL (and the app's callback URL).`)
          : err));
      server.listen(port, cb.hostname.replace(/^\[|\]$/g, ""), () => resolve());
    });
    this.server = server;
  }

  private maybeCloseServer() {
    if (this.pending.size === 0 && this.server) {
      this.server.close();
      this.server = undefined;
    }
  }

  // ---------- tokens ----------

  /** Returns a valid access token for the character, refreshing (and rotating the refresh token) as needed. */
  async accessToken(characterId: number): Promise<string> {
    const c = this.store.get(characterId);
    if (!c) throw new UserError(`Character ${characterId} is not logged in.`);
    if (c.access_token && c.expires_at && c.expires_at - REFRESH_MARGIN_MS > Date.now()) return c.access_token;
    let inflight = this.refreshing.get(characterId);
    if (!inflight) {
      inflight = this.refresh(c).finally(() => this.refreshing.delete(characterId));
      this.refreshing.set(characterId, inflight);
    }
    return inflight;
  }

  private async refresh(c: StoredCharacter): Promise<string> {
    try {
      const tokens = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: c.refresh_token });
      const fresh = await this.characterFromTokens(tokens);
      this.store.updateTokens(c.id, {
        access_token: fresh.access_token,
        refresh_token: fresh.refresh_token,
        expires_at: fresh.expires_at,
        scopes: fresh.scopes,
        name: fresh.name,
        last_refresh_error: undefined,
      });
      return fresh.access_token!;
    } catch (err) {
      const msg = (err as Error).message;
      this.store.updateTokens(c.id, { last_refresh_error: msg });
      if ((err as any).status === 400 || (err as any).status === 401) {
        throw new UserError(
          `The SSO grant for ${c.name} is no longer valid (revoked, expired or app changed). Call character_login to re-authorize. (${msg})`,
        );
      }
      throw err;
    }
  }

  async revoke(c: StoredCharacter): Promise<void> {
    try {
      const clientId = this.requireClient();
      const { revocation_endpoint } = await this.meta();
      const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": this.cfg.userAgent };
      const body = new URLSearchParams({ token_type_hint: "refresh_token", token: c.refresh_token });
      if (this.cfg.clientSecret) headers.Authorization = "Basic " + Buffer.from(`${clientId}:${this.cfg.clientSecret}`).toString("base64");
      else body.set("client_id", clientId);
      await fetch(revocation_endpoint, { method: "POST", headers, body });
    } catch (err) {
      log("Token revoke failed:", (err as Error).message);
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0f14;color:#d8e1ea;display:grid;place-items:center;height:100vh;margin:0}
main{max-width:32rem;padding:2rem;border:1px solid #2a3542;border-radius:12px;background:#111821}
h1{font-size:1.3rem;margin-top:0}</style></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
}
