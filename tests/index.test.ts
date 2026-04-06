import { describe, test, expect } from "bun:test";
describe("distributed-lock-manager", () => {
  test("module loads", async () => { const m = await import("./index"); expect(m).toBeDefined(); });
});
