# distributed-lock-manager

Redis-backed distributed locks for critical sections — **shared & exclusive** leases with TTL-based fail-safety, automatic **renewal**, and **exponential-backoff retry**. Works in-memory out of the box and scales to cross-node coordination over Redis.

[![CI](https://github.com/Retsumdk/distributed-lock-manager/workflows/CI/badge.svg)](https://github.com/Retsumdk/distributed-lock-manager/actions)
[![TypeScript](https://img.shields.io/badge/typescript-5.3-blue.svg)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/runtime-bun-black.svg)](https://bun.sh/)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![MIT License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

---

## The Problem

In a distributed system, multiple processes can touch the same resource at the same time — reading a counter, writing a document, running a job, electing a leader. Naive in-process mutexes don't help, because the race is *across machines*. And any lock that relies on a manual `release()` in the happy path is one crash away from a **deadlock** (a process dies holding a lock nobody can ever take).

You need a lock that:

- leases the resource for a bounded time (**TTL**) so a crashed holder can't block everyone forever;
- is **renewable**, so a long critical section can extend its lease without dropping it;
- supports **readers/writers** semantics (many readers, one writer) — not just a blunt "one holder" mutex;
- is **safe to release** only from the process that owns it (an identity check, not a blind key delete that could free someone else's lock);
- retries with **backoff/jitter** when the resource is momentarily contended, instead of failing or thundering-herding.

## The Solution

`distributed-lock-manager` provides all of that behind a single small `DistributedLockManager` class with a pluggable backend:

- **`MemoryBackend`** — zero-setup, in-process locking. Perfect for tests, single-node runs, and as the default so the library is usable *before* you stand up Redis.
- **`RedisBackend`** — atomic, multi-node synchronization over a single ioredis client. Every acquire/release/renew is a **Lua script** (atomic on the server), and each holder is stored in a Redis **sorted set keyed by expiry timestamp**, so leases expire naturally and lazily without cron janitors.

Each lease is identified by a self-contained **ownership id** (`mode|token|nonce`) embedded in the storage, so a release can *only* remove the exact lease it was granted. A misbehaving or stale client can never delete another holder's lock.

### Highlights

- **Shared / exclusive** (`reader`/`writer`) locking with correct mutual exclusion in both directions.
- **TTL fail-safety** — a crashed holder's lease expires on its own.
- **Watchdog-friendly** — renew the lease from a background loop (or a long `setInterval`) without re-acquiring.
- **Exponential retry with jitter** — configurable attempts, base delay, and jitter factor to avoid thundering herds.
- **`withLock()` helper** — acquire, run, release in all code paths, including exceptions.
- **Observable** — `holders(resource)` returns the live holders at any moment for dashboards/debugging.
- **Framework-agnostic** — pure promise API; use it in any Node/Bun app, any framework.
- **Zero-crypto-drive-by footguns** — the ownership nonce makes "am I still the lock holder?" a first-class question (`isHeld()` + `LockOwnershipError`).

## How It Works

```
                    ┌─────────────────────────────┐
   app / worker     │      DistributedLockManager  │
                    │  acquire() │ renew() │ release│
                    └──────┬──────────────────────┘
                           │  pluggable
                    ┌──────▼────────┐   ┌───────────────┐
                    │  MemoryBackend │   │  RedisBackend  │
                    │  (Map per key) │   │ (Lua + sorted set) │
                    └───────────────┘   └───────────────┘
```

For a given resource, the backend keeps a set of **holders**, each with an absolute expiry (`untilEpochMs`). An *exclusive* lease is granted only when the set is empty; a *shared* lease is granted only when no exclusive holder is present; neither is granted to the same token twice.

**Expiry is lazy**: an expired holder is invisible to new acquirers (and to `getHolders`), so nothing needs to run on a timer to clean it up — staleness self-heals on the next interaction. `RedisBackend` expresses this as a single sorted `ZSET` per resource whose **score is the millisecond expiry**, pruned and tested inside one atomic Lua script.

### The ownership nonce

Every lease stores `{mode}|{token}|{nonce}`. `release()` and `renew()` target that exact member, so even if two processes hold the same *resource* (shared mode) or a stale process tries to release after its lease was taken, the wrong holder can never be evicted. Identity is checked on the server side, in Lua, atomically.

## Installation

```bash
# Bun
bun add distributed-lock-manager
# npm / pnpm / yarn
npm install distributed-lock-manager
pnpm add distributed-lock-manager
```

## Quick Start (in-memory, zero setup)

```typescript
import { DistributedLockManager } from "distributed-lock-manager";

const locks = new DistributedLockManager(); // MemoryBackend by default

const lock = await locks.acquire("critical-resource");
if (!lock) {
  // Eventual/failure path — resource still held. Decide: wait, degrade, or fail.
  return;
}

try {
  await doCriticalWork();
} finally {
  await lock.release();
}
```

## Quick Start (Redis, cross-node)

```typescript
import { Redis } from "ioredis";
import { DistributedLockManager } from "distributed-lock-manager";

const redis = new Redis("redis://localhost:6379");
const locks = new DistributedLockManager({ backend: new RedisBackend(redis) });

// One critical section, many contenders
const lock = await locks.acquire("checkout:order-42", { mode: "exclusive" });
if (!lock) throw new Error("Could not lock order 42");
try {
  // decrement stock, charge, dispatch…
} finally {
  await lock.release();
}
redis.disconnect();
```

> **Tip:** install `ioredis` in your own `package.json` for the Redis backend; the core in-memory API has zero dependencies.

## Readers / writers (shared & exclusive)

```typescript
const reader1 = await locks.acquire("team-doc", { mode: "shared" });
const reader2 = await locks.acquire("team-doc", { mode: "shared" });
// both readers hold the lease concurrently ✅

const writer = await locks.acquire("team-doc", { mode: "exclusive", retryAttempts: 0 });
// -> null while any shared reader holds it; writer waits

await reader1.release();
await reader2.release();
const writer2 = await locks.acquire("team-doc", { mode: "exclusive" }); // ✅ now granted
```

## Automatic renewal (watchdog)

Long-running critical sections should renew their lease so it doesn't expire mid-work, but stop renewing if the lease was lost:

```typescript
const lock = await locks.acquire("long-job");

const watchdog = setInterval(async () => {
  try {
    await lock.renew(); // keeps the lease alive; throws LockOwnershipError if lost
  } catch {
    clearInterval(watchdog); // someone else took it — stop pretending we own it
  }
}, 5000);

try {
  await runLongJob(); // longer than default 30s TTL — renewal keeps it safe
} finally {
  clearInterval(watchdog);
  await lock.release();
}
```

## One-shot with `withLock`

```typescript
await locks.withLock("dedup:event-123", { retryAttempts: 5, retryDelayMs: 50 }, async () => {
  // runs exactly once across the cluster
  return processEvent(123);
});
```

`withLock` guarantees `release()` runs even if the callback throws.

## API

### `new DistributedLockManager(options?)`

| Option            | Type        | Default | Description |
|-------------------|-------------|---------|-------------|
| `backend`         | `LockBackend`| `MemoryBackend` | Storage + atomicity engine. Swap in `new RedisBackend(redis)` for distributed use. |
| `defaultTtlMs`    | `number`    | `30_000` | Lease length when `acquire()` doesn't specify one |
| `retryAttempts`   | `number`    | `3`      | Retries after an initial conflict before returning `null` |
| `retryDelayMs`    | `number`    | `150`    | Base delay for the first retry (`delay·2ⁿ` per attempt) |
| `jitter`          | `number`    | `0.25`   | Random jitter factor on each delay (`0`–`1`) to avoid thundering herds |

### `acquire(resource, options?) → Promise<LockHandle | null>`

| Option           | Type        | Default       | Description |
|------------------|-------------|---------------|-------------|
| `mode`           | `"shared" \| "exclusive"` | `"exclusive"` | Reader vs writer lease |
| `ttlMs`          | `number`    | `defaultTtlMs`| Lease duration |
| `token`          | `string`    | random        | Stable caller identity (for idempotent renew/release across restarts) |
| `retryAttempts`  | `number`    | manager default | Attempts before returning `null` |
| `retryDelayMs`   | `number`    | manager default | Base retry delay |

Returns the `LockHandle` on success, `null` when the lease is still contended after retries.

### `LockHandle`

- `resource: string` — the resource name
- `token: string` — the stable caller identity (or the generated one)
- `mode: LockMode` — `"shared" | "exclusive"`
- `isHeld(): boolean` — whether this cursor still believes it owns the lease locally
- `renew(ttlMs?): Promise<LockHandle>` — extend the lease; throws `LockOwnershipError` if no longer owner
- `release(): Promise<boolean>` — `true` if the lease was actively held and released, `false` if it had already expired

### `holders(resource) → Promise<Holder[]>`

Live, non-expired holders (`{ mode, token, untilEpochMs }`) for observability, quorum checks, and debugging.

### `withLock(resource, options, fn) → Promise<T>`

Acquire, run `fn`, release — even on error.

### Errors

- **`LockOwnershipError`** — thrown when `renew()` or `acquire()`-guarded ops discover the caller is not the current owner (stale watchdog, lost lease, wrong token). Always safe to retry.

### Backends

- `MemoryBackend` — `new MemoryBackend()`; in-memory, per-resource `Map`. Great for tests & single-node.
- `RedisBackend` — `new RedisBackend(redis, { prefix?: string })`; atomic Lua scripts + per-resource sorted set (score = expiry ms). `prefix` namespaces lock keys (default `"dlock"`).

## Example: cluster-wide unique job execution

```typescript
import { Redis } from "ioredis";
import { DistributedLockManager } from "distributed-lock-manager";

const locks = new DistributedLockManager({
  backend: new RedisBackend(new Redis()),
  retryAttempts: 8,
  retryDelayMs: 100,
});

const jobId = "nightly-report-v43";
const worker = await locks.acquire(`job:${jobId}`);
if (!worker) {
  console.log(`[worker] ${jobId} is already running elsewhere — exiting`);
  process.exit(0);
}

const watchdog = setInterval(() => worker.renew().catch(() => process.exit(0)), 20_000);
try {
  await generateNightlyReport();
  console.log(`[worker] finished ${jobId}`);
} finally {
  clearInterval(watchdog);
  await worker.release();
  process.exit(0);
}
```

## License

MIT License — see [LICENSE](LICENSE).

---

Built by [Retsumdk](https://github.com/Retsumdk)
