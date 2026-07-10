// Shared optional Redis accessor (server-only).
//
// Backed by a standard Redis (RESP over TCP) reached through `REDIS_URL` — e.g.
// a Railway Redis via its public TCP proxy: redis://default:<pw>@host:port.
// If `REDIS_URL` is absent, this returns null and callers fall back to an
// in-memory store, so the app runs locally with zero setup and lights up
// cross-device the moment a real URL is added. `ioredis` is imported
// dynamically so a deploy without it never fails to build.

export type RedisClient = {
  get: <T = unknown>(key: string) => Promise<T | null>;
  set: (key: string, value: unknown, opts?: { ex?: number }) => Promise<unknown>;
  del: (key: string) => Promise<unknown>;
  lpush: (key: string, ...values: unknown[]) => Promise<number>;
  lrange: <T = unknown>(key: string, start: number, stop: number) => Promise<T[]>;
  ltrim: (key: string, start: number, stop: number) => Promise<unknown>;
  zincrby: (key: string, increment: number, member: string) => Promise<unknown>;
  incr: (key: string) => Promise<number>;
  incrby: (key: string, increment: number) => Promise<number>;
  expire: (key: string, seconds: number) => Promise<unknown>;
  // Hash ops — used for live presence (one field per viewer, so concurrent viewer
  // heartbeats are per-field atomic writes, never a lost-update read-modify-write).
  hset: (key: string, field: string, value: unknown) => Promise<number>;
  hgetall: <T = unknown>(key: string) => Promise<Record<string, T>>;
  hdel: (key: string, ...fields: string[]) => Promise<number>;
};

let redisPromise: Promise<RedisClient | null> | null = null;

// Match @upstash/redis semantics over a raw RESP client: objects are JSON
// round-tripped; strings pass through untouched so pre-stringified payloads
// (e.g. the privacy-safe token event) aren't double-encoded.
function enc(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}
function dec<T>(s: string | null): T | null {
  if (s == null) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return s as unknown as T;
  }
}

export function getRedis(): Promise<RedisClient | null> {
  if (!process.env.REDIS_URL) return Promise.resolve(null);
  if (!redisPromise) {
    redisPromise = (async () => {
      try {
        const { default: Redis } = await import("ioredis");
        const client = new Redis(process.env.REDIS_URL as string, {
          // Serverless-friendly: one reused connection per warm instance, fail
          // fast if the store is unreachable, and don't spin forever on retries.
          maxRetriesPerRequest: 2,
          enableReadyCheck: false,
          connectTimeout: 10_000,
          lazyConnect: false,
        });
        // Swallow connection-level errors so a Redis blip never becomes an
        // unhandled exception — every caller already falls back to memory.
        client.on("error", () => {});
        const wrapped: RedisClient = {
          get: async <T = unknown>(key: string) => dec<T>(await client.get(key)),
          set: (key: string, value: unknown, opts?: { ex?: number }) =>
            opts?.ex
              ? client.set(key, enc(value), "EX", opts.ex)
              : client.set(key, enc(value)),
          del: (key: string) => client.del(key),
          lpush: (key: string, ...values: unknown[]) =>
            client.lpush(key, ...values.map(enc)),
          lrange: async <T = unknown>(key: string, start: number, stop: number) =>
            (await client.lrange(key, start, stop)).map((s) => dec<T>(s) as T),
          ltrim: (key: string, start: number, stop: number) => client.ltrim(key, start, stop),
          zincrby: (key: string, increment: number, member: string) =>
            client.zincrby(key, increment, member),
          incr: (key: string) => client.incr(key),
          incrby: (key: string, increment: number) => client.incrby(key, increment),
          expire: (key: string, seconds: number) => client.expire(key, seconds),
          hset: (key: string, field: string, value: unknown) => client.hset(key, field, enc(value)),
          hgetall: async <T = unknown>(key: string) => {
            const raw = await client.hgetall(key);
            const out: Record<string, T> = {};
            for (const k of Object.keys(raw)) out[k] = dec<T>(raw[k]) as T;
            return out;
          },
          hdel: (key: string, ...fields: string[]) => client.hdel(key, ...fields),
        };
        return wrapped;
      } catch {
        return null; // package not installed / bad URL — degrade gracefully
      }
    })();
  }
  return redisPromise;
}

/** True when a real Redis store is configured (used to warn about the fallback). */
export function hasRedis(): boolean {
  return Boolean(process.env.REDIS_URL);
}
