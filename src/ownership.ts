import type { LockMode } from "./types";
import { randomUUID } from "node:crypto";

/**
 * Format an ownership id. An ownership id is a self-contained, content-addressed
 * identity that is safe to use as a Redis set/hash member: it fixes the holder's
 * mode inside the id so the Redis Lua scripts never have to trust a separate
 * mode argument. Format: `<mode>|<id>|<nonce>`.
 */
export function buildOwnershipId(mode: LockMode, id: string, nonce = randomUUID()): string {
  return `${mode}|${id}|${nonce}`;
}

export interface ParsedOwnershipId {
  mode: LockMode;
  id: string;
  nonce: string;
}

/** Split a previously built ownership id back into its parts. */
export function parseOwnershipId(raw: string): ParsedOwnershipId | null {
  const [mode, id, nonce, ...rest] = raw.split("|");
  if ((mode !== "shared" && mode !== "exclusive") || !id || !nonce || rest.length > 0) {
    return null;
  }
  return { mode, id, nonce };
}
