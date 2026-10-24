import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { EsiError } from "../esi/client.js";
import { UserError, compact, log } from "../util.js";

export const characterParam = z
  .string()
  .optional()
  .describe("Character name or id to act as. Defaults to the active character (see characters_list / character_select).");

export interface Extra {
  /** Additional verbatim text blocks (e.g. EFT) so the model can copy them without JSON escaping. */
  texts?: string[];
}

export function reply(data: unknown, extra: Extra = {}): CallToolResult {
  const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(compact(data), null, 1) }];
  for (const t of extra.texts ?? []) content.push({ type: "text", text: t });
  return { content };
}

export function errorReply(err: unknown): CallToolResult {
  const message =
    err instanceof UserError || err instanceof EsiError ? err.message : `Unexpected error: ${(err as Error)?.message ?? String(err)}`;
  if (!(err instanceof UserError)) log(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Wraps a tool handler so thrown errors become MCP tool errors with readable messages. */
export function handler<A>(fn: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      return errorReply(err);
    }
  };
}

/** Runs a section of a composite response, recording the error instead of failing the whole call. */
export async function section<T>(errors: Record<string, string>, name: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    errors[name] = (err as Error).message;
    return undefined;
  }
}

export const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;
