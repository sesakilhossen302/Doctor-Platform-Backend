import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Read-through cache for hot, read-heavy endpoints (locations, specialties, doctor lists).
 *
 * - Uses Redis when REDIS_URL is set (shared by every API process / server).
 * - Falls back to a bounded in-memory LRU when Redis is not configured (dev only).
 * - wrap() de-duplicates concurrent misses for the same key, so 10 000 simultaneous
 *   requests for a cold key trigger ONE database query (cache-stampede protection).
 * - Namespaces are versioned: bump('doctors') invalidates every cached doctor query at once.
 */
@Injectable()
export class CacheService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private readonly redis?: Redis;
  private readonly mem = new Map<string, { v: string; e: number }>();
  private readonly memVersions = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private static readonly MEM_MAX = 5000;

  constructor(config: ConfigService) {
    const url = config.get<string>('REDIS_URL');
    if (url) {
      this.redis = new Redis(url, { maxRetriesPerRequest: 2, enableAutoPipelining: true });
      this.redis.on('error', (e) => this.logger.error(`Redis error: ${e.message}`));
      this.logger.log('Cache: Redis');
    } else {
      this.logger.warn('Cache: in-memory (set REDIS_URL for production / multi-instance)');
    }
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      if (this.redis) {
        const raw = await this.redis.get(key);
        return raw ? (JSON.parse(raw) as T) : null;
      }
      const hit = this.mem.get(key);
      if (!hit) return null;
      if (hit.e < Date.now()) {
        this.mem.delete(key);
        return null;
      }
      this.mem.delete(key); // refresh LRU position
      this.mem.set(key, hit);
      return JSON.parse(hit.v) as T;
    } catch (e) {
      this.logger.warn(`cache get failed: ${(e as Error).message}`);
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const raw = JSON.stringify(value);
    try {
      if (this.redis) {
        await this.redis.set(key, raw, 'EX', ttlSeconds);
        return;
      }
      if (this.mem.size >= CacheService.MEM_MAX) {
        const oldest = this.mem.keys().next().value;
        if (oldest !== undefined) this.mem.delete(oldest);
      }
      this.mem.set(key, { v: raw, e: Date.now() + ttlSeconds * 1000 });
    } catch (e) {
      this.logger.warn(`cache set failed: ${(e as Error).message}`);
    }
  }

  async del(key: string): Promise<void> {
    if (this.redis) await this.redis.del(key).catch(() => undefined);
    else this.mem.delete(key);
  }

  async version(ns: string): Promise<number> {
    if (this.redis) {
      const v = await this.redis.get(`ver:${ns}`).catch(() => null);
      return v ? Number(v) : 1;
    }
    return this.memVersions.get(ns) ?? 1;
  }

  /** Invalidate every key in the given namespaces. */
  async bump(...namespaces: string[]): Promise<void> {
    for (const ns of namespaces) {
      if (this.redis) await this.redis.incr(`ver:${ns}`).catch(() => undefined);
      else this.memVersions.set(ns, (this.memVersions.get(ns) ?? 1) + 1);
    }
  }

  /** Versioned key, e.g. "doctors:v3:list:..." */
  async key(ns: string, suffix: string): Promise<string> {
    return `${ns}:v${await this.version(ns)}:${suffix}`;
  }

  async wrap<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    const pending = this.inflight.get(key) as Promise<T> | undefined;
    if (pending) return pending;

    const p = (async () => {
      try {
        const fresh = await loader();
        await this.set(key, fresh, ttlSeconds);
        return fresh;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  /**
   * Redis outlives deployments. Data may have changed outside the API (migrations, seed),
   * so start every deployment with fresh cached reads.
   */
  async onApplicationBootstrap() {
    await this.bump('locations', 'catalog', 'doctors');
    for (const key of ['fees:settings', 'settings:all', 'admin:dashboard']) await this.del(key);
  }

  async onModuleDestroy() {
    await this.redis?.quit().catch(() => undefined);
  }
}
