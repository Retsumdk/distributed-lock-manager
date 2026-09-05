import type { Holder, LockBackend, LockMode } from "./types";
import { parseOwnershipId } from "./ownership";

interface Entry {
  token: string;
  mode: LockMode;
  untilEpochMs: number;
}

/** Prune expired entries and return the live holders for `map`, newest-last. */
function live(map: Map<string, Entry>, now = Date.now()): Holder[] {
  const out: Holder[] = [];
  for (const [token, e] of map) {
    if (e.untilEpochMs <= now) {
      map.delete(token);
    } else {
      out.push({ mode: e.mode, id: token, nonce: "", untilEpochMs: e.untilEpochMs });
    }
  }
  return out;
}

function prune(map: Map<string, Entry>, now = Date.now()): void {
  for (const [token, e] of [...map]) {
    if (e.untilEpochMs <= now) map.delete(token);
  }
}

/**
 * In-memory {@link LockBackend}. Nonces are discarded (the owning manager
 * instance cannot collide with itself across a single process), matching the
 * truthfulness guarantees of the Redis backend minus distributed ownership.
 * Used by the default manager configuration and by every test.
 */
export class MemoryBackend implements LockBackend {
  readonly name = "memory";
  private readonly locks = new Map<string, Map<string, Entry>>();

  async acquire(resource: string, ownershipId: string, ttlMs: number): Promise<boolean> {
    const parsed = parseOwnershipId(ownershipId);
    if (!parsed) return false;
    const expires = Date.now() + ttlMs;
    let slot = this.locks.get(resource);
    if (!slot) {
      this.locks.set(resource, (slot = new Map()));
    }
    prune(slot);
    const conflict = [...slot.values()].some(
      (e) => e.untilEpochMs > Date.now() && (parsed.mode === "exclusive" || e.mode === "exclusive"),
    );
    if (conflict) return false;
    slot.set(parsed.id, { token: parsed.id, mode: parsed.mode, untilEpochMs: expires });
    return true;
  }

  async release(resource: string, ownershipId: string): Promise<boolean> {
    const parsed = parseOwnershipId(ownershipId);
    if (!parsed) return false;
    const slot = this.locks.get(resource);
    if (!slot) return false;
    const entry = slot.get(parsed.id);
    if (!entry || entry.untilEpochMs <= Date.now()) return false;
    slot.delete(parsed.id);
    if (slot.size === 0) this.locks.delete(resource);
    return true;
  }

  async renew(resource: string, ownershipId: string, ttlMs: number): Promise<boolean> {
    const parsed = parseOwnershipId(ownershipId);
    if (!parsed) return false;
    const slot = this.locks.get(resource);
    const entry = slot?.get(parsed.id);
    if (!entry || entry.mode !== parsed.mode || entry.untilEpochMs <= Date.now()) return false;
    entry.untilEpochMs = Date.now() + ttlMs;
    return true;
  }

  async getHolders(resource: string): Promise<Holder[]> {
    return live(this.locks.get(resource) ?? new Map());
  }
}
