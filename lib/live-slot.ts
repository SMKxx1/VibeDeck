// The "one live record per deck" storage pattern (server-only), factored out of
// lib/recap.ts and lib/activity.ts — which were structurally the same file with a
// different payload. A live slot holds a SINGLE value per deck slug: setting
// replaces, getting reads, clearing removes it for every viewer at once.
//
// Deliberately NOT used by lib/signals.ts / lib/pinboard.ts: those are capped
// LISTS (LPUSH + LTRIM, with their own trim/expiry and eviction machinery), not a
// single slot, so forcing them through this factory would cost more than it saves.
//
// Every convention below is preserved verbatim from the two callers because prod
// Redis holds live data in exactly this shape: the key is `<keyPrefix>:<slug>`,
// the value is the caller's record serialized by lib/redis.ts, the TTL is the
// caller's, and every Redis touch is best-effort — a store blip degrades to the
// in-memory fallback and never throws.

import { getRedis } from "./redis";

export interface LiveSlotOptions<T> {
  /** Full key is `<keyPrefix>:<slug>`. This string IS the on-disk format. */
  keyPrefix: string;
  ttlSeconds: number;
  /**
   * globalThis property holding the fallback Map. Named per slot (rather than
   * closed over) so the fallback survives Next dev hot-reloads — see lib/pinboard.ts.
   */
  memoryKey: string;
  /** Reject a stored record that isn't the shape this slot writes. */
  isValid: (value: unknown) => value is T;
}

export interface LiveSlot<T> {
  /** Set (or replace) the slug's record. Returns what was stored. */
  set: (slug: string, value: T) => Promise<T>;
  /** The slug's record, or null when absent/unreadable. */
  get: (slug: string) => Promise<T | null>;
  /** Remove the record everywhere. Best-effort. */
  clear: (slug: string) => Promise<void>;
}

export function makeLiveSlot<T>({
  keyPrefix,
  ttlSeconds,
  memoryKey,
  isValid,
}: LiveSlotOptions<T>): LiveSlot<T> {
  const keyFor = (slug: string) => `${keyPrefix}:${slug}`;
  const g = globalThis as unknown as Record<string, Map<string, T> | undefined>;
  const mem = (g[memoryKey] ??= new Map<string, T>());

  return {
    async set(slug, value) {
      // Memory is written unconditionally: it is both the no-Redis store AND the
      // read-through fallback if the next get hits a store blip.
      mem.set(slug, value);
      const redis = await getRedis();
      if (redis) {
        try {
          await redis.set(keyFor(slug), value, { ex: ttlSeconds });
        } catch {
          /* best-effort */
        }
      }
      return value;
    },

    async get(slug) {
      const redis = await getRedis();
      if (redis) {
        try {
          // A REACHABLE store is authoritative: a missing or malformed record
          // means "nothing is active", not "go look in memory".
          const stored = await redis.get(keyFor(slug));
          return isValid(stored) ? stored : null;
        } catch {
          /* fall through to memory */
        }
      }
      return mem.get(slug) ?? null;
    },

    async clear(slug) {
      mem.delete(slug);
      const redis = await getRedis();
      if (redis) {
        try {
          await redis.del(keyFor(slug));
        } catch {
          /* best-effort */
        }
      }
    },
  };
}
