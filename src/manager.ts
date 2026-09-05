import { randomUUID } from "node:crypto";
import type { Holder, LockBackend } from "./types";
import { MemoryBackend } from "./memoryBackend";
import { buildOwnershipId } from "./ownership";

import type { LockMode } from "./types";

/**
 * Raised by {@link DistributedLockManager.acquire} when the caller's `token`
 * is not the incumbent for the requested lease (an ownership mismatch, e.g. a
 * stale watchdog trying to renew a lock that was already handed to another
 * node). Always retryable.
 */
export class LockOwnershipError extends Error {
  constructor(public readonly resource: string, public readonly token: string) {
    super(`No longer holds resource "${resource}" under token "${token}"`);
    this.name = "LockOwnershipError";
  }
}

/** Options accepted by {@link DistributedLockManager.acquire}. */
export interface AcquireOptions {
  mode?: LockMode;
  ttlMs?: number;
  token?: string;
  retryAttempts?: number;
  retryDelayMs?: number;
  backoffJitter?: number;
}

export interface ManagerOptions {
  backend?: LockBackend;
  defaultTtlMs?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
  jitter?: number;
}

export interface LockHandle {
  readonly resource: string;
  readonly token: string;
  readonly mode: LockMode;
  isHeld(): boolean;
  renew(ttlMs?: number): Promise<LockHandle>;
  release(): Promise<boolean>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A cursor/lease a caller holds on a resource. */
class ManagedHandle implements LockHandle {
  private held = true;

  constructor(
    private readonly manager: DistributedLockManager,
    readonly resource: string,
    readonly storageKey: string,
    readonly token: string,
    readonly mode: LockMode,
    private readonly backend: LockBackend,
    readonly ownershipId: string,
    private readonly ttlMs: number,
  ) {}

  isHeld(): boolean {
    return this.held;
  }

  /** Reset the lease cursor so `acquire` can't double-serve this grant. */
  cancel(): void {
    this.held = false;
  }

  /** Renew the lease for another `ttlMs`. Fails fast, frees the cursor first. */
  async renew(ttlMs = this.ttlMs): Promise<LockHandle> {
    if (!this.held) throw new LockOwnershipError(this.resource, this.token);
    return this.manager.renew(this, ttlMs);
  }

  async release(): Promise<boolean> {
    if (!this.held) return false;
    this.held = false;
    try {
      return await this.backend.release(this.storageKey, this.ownershipId);
    } catch {
      return false;
    }
  }
}

/**
 * A distributed lock manager supporting shared and exclusive leases over a
 * pluggable backend (in-memory by default, Redis for real cross-node
 * synchronization). Composes acquire, retry-with-backoff, watch-dog renewal
 * and safe release around the {@link LockBackend} contract.
 */
export class DistributedLockManager {
  private readonly backend: LockBackend;
  private readonly defaultTtlMs: number;
  private readonly retryAttempts: number;
  private readonly retryDelayMs: number;
  private readonly jitter: number;

  constructor(options: ManagerOptions = {}) {
    this.backend = options.backend ?? new MemoryBackend();
    this.defaultTtlMs = options.defaultTtlMs ?? 30_000;
    this.retryAttempts = options.retryAttempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 150;
    this.jitter = options.jitter ?? 0.25;
  }

  private backoff(attempt: number, delay = this.retryDelayMs, jitterAmt = this.jitter): number {
    const jittered = delay * (1 - jitterAmt * Math.random());
    // exponential growth starting from the base delay
    return Math.max(1, Math.round(jittered * Math.pow(2, attempt)));
  }

  private maxAttempts(): number {
    return Math.max(0, this.retryAttempts);
  }

  private async tryAcquire(
    resource: string,
    mode: LockMode,
    ttlMs: number,
    token: string,
  ): Promise<ManagedHandle | null> {
    const ownershipId = buildOwnershipId(mode, token);
    // The storage key is the resource name; the backend owns any namespacing.
    const ok = await this.backend.acquire(resource, ownershipId, ttlMs);
    if (!ok) return null;
    return new ManagedHandle(this, resource, resource, token, mode, this.backend, ownershipId, ttlMs);
  }

  /**
   * Acquire a lease on `resource`. Retries (with exponential, jittered backoff)
   * until granted or `retryAttempts` are exhausted, then returns `null` so the
   * caller can decide whether to busy-wait or fail. Pass your own `token` to
   * make renewal/release idempotent across process restarts; otherwise a
   * random one is generated.
   */
  async acquire(
    resource: string,
    options: AcquireOptions = {},
  ): Promise<LockHandle | null> {
    const mode = options.mode ?? "exclusive";
    const ttlMs = options.ttlMs ?? this.defaultTtlMs;
    const token = options.token ?? randomUUID();
    const attempts = options.retryAttempts ?? this.maxAttempts();
    const delay = options.retryDelayMs ?? this.retryDelayMs;

    for (let i = 0; i <= attempts; i++) {
      const handle = await this.tryAcquire(resource, mode, ttlMs, token);
      if (handle) return handle;
      if (i < attempts) {
        await sleep(this.backoff(i, delay, this.jitter));
      }
    }
    return null;
  }

  /** List the live holders currently leasing `resource`. */
  async holders(resource: string): Promise<Holder[]> {
    return this.backend.getHolders(resource);
  }

  /** Acquire and hold a lease for the duration of `fn`, releasing in all paths. */
  async withLock<T>(
    resource: string,
    options: AcquireOptions,
    fn: (lock: LockHandle) => Promise<T> | T,
  ): Promise<T> {
    const lock = await this.acquire(resource, options);
    if (!lock) throw new Error(`Timed out acquiring lock on resource "${resource}"`);
    try {
      return await fn(lock);
    } finally {
      await lock.release();
    }
  }

  /**
   * Renew an already-held lease from a newly acquired (or previously trusted)
   * cursor. Internal – prefer {@link LockHandle.renew} which guards ownership.
   */
  async renew(handle: ManagedHandle, ttlMs: number): Promise<LockHandle> {
    if (!handle.isHeld()) throw new LockOwnershipError(handle.resource, handle.token);
    try {
      const ok = await this.backend.renew(handle.storageKey, handle.ownershipId, ttlMs);
      if (!ok) {
        handle.cancel();
        throw new LockOwnershipError(handle.resource, handle.token);
      }
      return handle;
    } catch (err) {
      handle.cancel();
      throw err;
    }
  }
}
