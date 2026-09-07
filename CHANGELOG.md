# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-09-07

### Added

- `DistributedLockManager` class with a pluggable backend architecture.
- **`MemoryBackend`** — zero-setup, in-process locking for tests and single-node runs (the default, so the library works before Redis is standing up).
- **`RedisBackend`** — atomic, multi-node coordination over a single ioredis client; every acquire/release/renew is a server-side Lua script, and holders are stored in a Redis sorted set keyed by expiry timestamp so leases expire naturally without cron janitors.
- Shared (reader) and exclusive (writer) lease semantics — many readers or one writer.
- TTL-based fail-safety so a crashed holder cannot block the resource forever.
- Automatic lease renewal so a long critical section can extend its lock without dropping it.
- Identity-checked release so only the owning process can free a lock (no blind key delete).
- Exponential-backoff with jitter on contention, instead of failure or thundering-herd.
- CI workflow running the test suite on push.
- Full TypeScript types, JSDoc, and a polished README covering the problem, the solution, and usage for both backends.

[1.0.0]: https://github.com/Retsumdk/distributed-lock-manager/releases/tag/v1.0.0
