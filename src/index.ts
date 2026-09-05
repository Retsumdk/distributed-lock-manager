export {
  DistributedLockManager,
  LockOwnershipError,
  type AcquireOptions,
  type ManagerOptions,
  type LockHandle,
} from "./manager";
export { MemoryBackend } from "./memoryBackend";
export { RedisBackend, redisBackend } from "./redisBackend";
export type { LockBackend, LockMode, Holder } from "./types";
