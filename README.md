# distributed-lock-manager

[![Build](https://github.com/Retsumdk/distributed-lock-manager/workflows/Test/badge.svg)](https://github.com/Retsumdk/distributed-lock-manager/actions)
[![TypeScript](https://img.shields.io/badge/typescript-4.9-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![MIT License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Redis-based distributed locks for critical sections. A production-ready implementation for managing distributed synchronization in Node.js applications.

## Features

- **Redis-based locking** - Acquire and release locks with automatic expiration
- **TypeScript support** - Full type safety with comprehensive type definitions
- **Retry logic** - Configurable retry attempts with exponential backoff
- **Watchdog mechanism** - Automatic lock renewal to prevent deadlocks
- **Multiple lock modes** - Supports shared and exclusive locks

## Installation

```bash
npm install distributed-lock-manager
# or
pnpm add distributed-lock-manager
```

## Quick Start

```typescript
import { DistributedLockManager } from 'distributed-lock-manager';

const lockManager = new DistributedLockManager({
  redisUrl: 'redis://localhost:6379',
  defaultTtl: 30000,
  retryAttempts: 3,
});

async function criticalSection() {
  const lock = await lockManager.acquire('my-resource');
  try {
    // Your critical code here
    console.log('Lock acquired, executing critical section...');
  } finally {
    await lock.release();
  }
}
```

## Configuration

```typescript
{
  redisUrl: string;           // Redis connection URL
  defaultTtl: number;         // Lock TTL in milliseconds (default: 30000)
  retryAttempts: number;       // Number of retry attempts (default: 3)
  retryDelay: number;         // Delay between retries in ms (default: 1000)
  watchInterval: number;       // Watchdog check interval in ms (default: 10000)
}
```

## License

MIT License - see [LICENSE](LICENSE) for details.

---

Built by [The BookMaster](https://github.com/Retsumdk) with [Zo Computer](https://zo.computer)
