import { describe, test, expect } from "bun:test";
import {
  DistributedLockManager,
  MemoryBackend,
  LockOwnershipError,
} from "../src/index";
import { buildOwnershipId, parseOwnershipId } from "../src/ownership";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("ownership id", () => {
  test("buildOwnershipId round-trips through parseOwnershipId", () => {
    const raw = buildOwnershipId("exclusive", "svc-1");
    const parsed = parseOwnershipId(raw);
    expect(parsed).toEqual({ mode: "exclusive", id: "svc-1", nonce: expect.any(String) });
  });

  test("parseOwnershipId rejects malformed ids", () => {
    expect(parseOwnershipId("")).toBeNull();
    expect(parseOwnershipId("shared")).toBeNull();
    expect(parseOwnershipId("exclusive|svc-1")).toBeNull();
    expect(parseOwnershipId("bogus|svc-1|abc")).toBeNull();
  });
});

describe("MemoryBackend exclusive semantics", () => {
  test("acquire grants exclusive when free", async () => {
    const b = new MemoryBackend();
    expect(await b.acquire("jobs", "exclusive|a|1", 30000)).toBe(true);
    expect((await b.getHolders("jobs")).length).toBe(1);
  });

  test("second exclusive is denied while held", async () => {
    const b = new MemoryBackend();
    await b.acquire("jobs", "exclusive|a|1", 30000);
    expect(await b.acquire("jobs", "exclusive|b|1", 30000)).toBe(false);
  });

  test("release frees the resource", async () => {
    const b = new MemoryBackend();
    await b.acquire("jobs", "exclusive|a|1", 30000);
    expect(await b.release("jobs", "exclusive|a|1")).toBe(true);
    expect(await b.acquire("jobs", "exclusive|b|1", 30000)).toBe(true);
  });

  test("release does not remove a different holder", async () => {
    const b = new MemoryBackend();
    await b.acquire("jobs", "exclusive|a|1", 30000);
    expect(await b.release("jobs", "exclusive|evil|9")).toBe(false);
    expect((await b.getHolders("jobs")).length).toBe(1);
  });

  test("leases auto-expire", async () => {
    const b = new MemoryBackend();
    expect(await b.acquire("jobs", "exclusive|a|1", 5)).toBe(true);
    await sleep(15);
    expect((await b.getHolders("jobs")).length).toBe(0);
    expect(await b.acquire("jobs", "exclusive|b|1", 30000)).toBe(true);
  });

  test("renew extends a live lease and fails after expiry", async () => {
    const b = new MemoryBackend();
    await b.acquire("jobs", "exclusive|a|1", 30000);
    expect(await b.renew("jobs", "exclusive|a|1", 30000)).toBe(true);
    expect((await b.getHolders("jobs"))[0].untilEpochMs).toBeGreaterThan(Date.now());
    // Let it expire
    const tiny = new MemoryBackend();
    await tiny.acquire("x", "exclusive|a|1", 1);
    await sleep(15);
    expect(await tiny.renew("x", "exclusive|a|1", 30000)).toBe(false);
  });
});

describe("shared + exclusive interplay", () => {
  test("multiple shared holders coexist", async () => {
    const b = new MemoryBackend();
    expect(await b.acquire("doc", "shared|r1|1", 30000)).toBe(true);
    expect(await b.acquire("doc", "shared|r2|1", 30000)).toBe(true);
    expect((await b.getHolders("doc")).length).toBe(2);
  });

  test("shared denied when exclusive held", async () => {
    const b = new MemoryBackend();
    await b.acquire("doc", "exclusive|w1|1", 30000);
    expect(await b.acquire("doc", "shared|r1|1", 30000)).toBe(false);
  });

  test("exclusive denied when shared held", async () => {
    const b = new MemoryBackend();
    await b.acquire("doc", "shared|r1|1", 30000);
    expect(await b.acquire("doc", "exclusive|w1|1", 30000)).toBe(false);
  });
});

describe("DistributedLockManager (memory backend)", () => {
  test("acquire/release round trip through handle", async () => {
    const m = new DistributedLockManager();
    const h = await m.acquire("orders");
    expect(h.token).toBeTruthy();
    expect(await m.holders("orders")).toHaveLength(1);
    await h.release();
    expect(await m.holders("orders")).toHaveLength(0);
  });

  test("conflicting exclusive returns null (non-throwing)", async () => {
    const m = new DistributedLockManager();
    const a = await m.acquire("orders", { mode: "exclusive" });
    expect(await m.acquire("orders", { mode: "exclusive" })).toBeNull();
    await a.release();
  });

  test("renewing a lost lease throws LockOwnershipError", async () => {
    const m = new DistributedLockManager();
    const a = await m.acquire("orders", { mode: "exclusive" });
    await a.release();
    await expect(a.renew()).rejects.toBeInstanceOf(LockOwnershipError);
  });

  test("acquire(...) retries until the lease frees up", async () => {
    const m = new DistributedLockManager({ retryAttempts: 5, retryDelayMs: 10 });
    const a = await m.acquire("jobs", { mode: "exclusive" });
    // Release from a background task shortly
    const releaser = (async () => {
      await sleep(15);
      await a.release();
    })();
    const b = await m.acquire("jobs", { mode: "exclusive" });
    await releaser;
    await b.release();
  });

  test("renew() keeps the lease alive", async () => {
    const m = new DistributedLockManager({ defaultTtlMs: 30_000 });
    const h = await m.acquire("x");
    const renewed = await m.renew(h, 30_000);
    expect(renewed.token).toBe(h.token);
  });

  test("release-after-expiry returns false (no throw)", async () => {
    const m = new DistributedLockManager({ defaultTtlMs: 1 });
    const h = await m.acquire("x");
    await sleep(10);
    expect(await h.release()).toBe(false);
  });
});
