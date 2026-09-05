export type LockMode = "shared" | "exclusive";

/**
 * A live lock holder. `untilEpochMs` is the absolute expiry of that holder's
 * lease (in milliseconds since the Unix epoch), after which the holder is
 * considered expired and the lock may be granted to someone else.
 */
export interface Holder {
  mode: LockMode;
  id: string;
  nonce: string;
  untilEpochMs: number;
}

/**
 * Pluggable lock storage. Implemented by {@link MemoryBackend} for tests and
 * single-process use, and by {@link RedisBackend} for real distributed
 * synchronization. Every call is atomic with respect to the underlying store.
 */
export interface LockBackend {
  readonly name: string;

  /**
   * Try to hold `resource` under `ownershipId` for `ttlMs`. Returns `true`
   * only when the lock was granted (exclusive excludes everyone; shared is
   * gated only by a conflicting exclusive holder). When `false`, the caller
   * should retry after a backoff.
   */
  acquire(resource: string, ownershipId: string, ttlMs: number): Promise<boolean>;

  /** Relinquish a held lock. Returns `true` only when the caller still held it. */
  release(resource: string, ownershipId: string): Promise<boolean>;

  /** Renew a held lease by `ttlMs`. Returns `false` when no longer held / expired. */
  renew(resource: string, ownershipId: string, ttlMs: number): Promise<boolean>;

  /** List currently live holders (never includes expired ones). */
  getHolders(resource: string): Promise<Holder[]>;
}
