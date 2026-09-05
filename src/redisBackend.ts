import type { Redis } from "ioredis";
import type { Holder, LockBackend, LockMode } from "./types";
import { parseOwnershipId, buildOwnershipId } from "./ownership";

const EXCLUSIVE_PREFIX = "exclusive:";

/** Returns 1 when the lock was granted, 0 when it conflicts. */
const ACQUIRE_SCRIPT = `
local lockKey, holdersKey = KEYS[1], KEYS[2]
local ownershipId, mode = ARGV[1], ARGV[2]
local expiry, now = tonumber(ARGV[3]), tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', lockKey, '-inf', now)
local members = redis.call('ZRANGE', lockKey, 0, -1)
if mode == 'exclusive' then
  if #members > 0 then return 0 end
else
  for _, m in ipairs(members) do
    if string.sub(m, 1, string.len('${EXCLUSIVE_PREFIX}')) == '${EXCLUSIVE_PREFIX}' then
      return 0
    end
  end
end
redis.call('ZADD', lockKey, expiry, ownershipId)
redis.call('HSET', holdersKey, ownershipId, expiry)
local ttl = expiry - now
redis.call('PEXPIRE', lockKey, ttl)
redis.call('PEXPIRE', holdersKey, ttl)
return 1
`.trim();

/** Returns 1 when the holder was still live and was renewed, else 0. */
const RENEW_SCRIPT = `
local lockKey, holdersKey = KEYS[1], KEYS[2]
local ownershipId = ARGV[1]
local newExpiry, now = tonumber(ARGV[2]), tonumber(ARGV[3])
local score = redis.call('ZSCORE', lockKey, ownershipId)
if not score or tonumber(score) <= now then return 0 end
redis.call('ZADD', lockKey, newExpiry, ownershipId)
redis.call('HSET', holdersKey, ownershipId, newExpiry)
redis.call('PEXPIRE', lockKey, newExpiry - now)
redis.call('PEXPIRE', holdersKey, newExpiry - now)
return 1
`.trim();

/** Returns 1 when the holder was currently held (and removed), else 0. */
const RELEASE_SCRIPT = `
local lockKey, holdersKey = KEYS[1], KEYS[2]
local ownershipId = ARGV[1]
local removed = redis.call('ZREM', lockKey, ownershipId)
redis.call('HDEL', holdersKey, ownershipId)
return removed
`.trim();

/**
 * Redis-backed {@link LockBackend} for real distributed synchronization.
 *
 * Each resource maps to two keys under `prefix + resource`:
 *   - a sorted set whose member is `<mode>:<id>:<nonce>` and whose score is the
 *     absolute expiry timestamp (epoch ms) — per-holder leases,
 *   - a hash mirroring the same membership for cheap listing.
 *
 * Lock acquisition and renewal are single atomic Lua scripts, so there is no
 * check-then-act race between concurrent processes.
 */
export class RedisBackend implements LockBackend {
  readonly name = "redis";
  private readonly prefix: string;

  constructor(
    private readonly redis: Redis,
    options: { prefix?: string } = {},
  ) {
    this.prefix = options.prefix ?? "distributed-lock";
  }

  async acquire(resource: string, ownershipId: string, ttlMs: number): Promise<boolean> {
    const [lockKey, holdersKey] = this.keys(resource);
    const parsed = parseOwnershipId(ownershipId);
    if (!parsed) return false;
    const result = await this.redis.eval(
      ACQUIRE_SCRIPT,
      2,
      lockKey,
      holdersKey,
      ownershipId,
      parsed.mode,
      String(Date.now() + ttlMs),
      String(Date.now()),
    );
    return result === 1;
  }

  async release(resource: string, ownershipId: string): Promise<boolean> {
    const [lockKey, holdersKey] = this.keys(resource);
    const parsed = parseOwnershipId(ownershipId);
    if (!parsed) return false;
    const result = await this.redis.eval(RELEASE_SCRIPT, 2, lockKey, holdersKey, ownershipId);
    return result === 1;
  }

  async renew(resource: string, ownershipId: string, ttlMs: number): Promise<boolean> {
    const [lockKey, holdersKey] = this.keys(resource);
    const now = Date.now();
    const result = await this.redis.eval(
      RENEW_SCRIPT,
      2,
      lockKey,
      holdersKey,
      ownershipId,
      String(now + ttlMs),
      String(now),
    );
    return result === 1;
  }

  async getHolders(resource: string): Promise<Holder[]> {
    const [, holdersKey] = this.keys(resource);
    const flat = (await this.redis.hgetall(holdersKey)) as Record<string, string>;
    const now = Date.now();
    const out: Holder[] = [];
    for (const [ownershipId, untilStr] of Object.entries(flat)) {
      const untilEpochMs = Number(untilStr);
      if (untilEpochMs <= now) continue;
      const parsed = parseOwnershipId(ownershipId);
      if (!parsed) continue;
      out.push({ ...parsed, untilEpochMs });
    }
    return out;
  }

  private keys(resource: string): [string, string] {
    const base = `${this.prefix}:lock:${resource}`;
    return [`${base}:zset`, `${base}:holders`];
  }
}

/**
 * Construct a {@link RedisBackend} around an existing ioredis client.
 */
export function redisBackend(
  redis: Redis,
  options: { prefix?: string } = {},
): LockBackend {
  return new RedisBackend(redis, options);
}
