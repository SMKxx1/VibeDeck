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
  // Per-field atomic counter — used for the confusion pulse (one field per
  // (slide,event), so concurrent viewer signals increment without a lost-update
  // read-modify-write, same rationale as hset above).
  hincrby: (key: string, field: string, increment: number) => Promise<number>;
  // Set-if-absent — used to record a hash's first-write timestamp exactly once.
  hsetnx: (key: string, field: string, value: unknown) => Promise<number>;
  hlen: (key: string) => Promise<number>;
  /** Execute one of the small, constant scripts owned by this application. */
  eval: <T = unknown>(script: string, keys: string[], args?: Array<string | number>) => Promise<T>;
  ping: () => Promise<string>;
};

let redisPromise: Promise<RedisClient | null> | null = null;
let retryAfter = 0;
let lastErrorLog = 0;

const RETRY_DELAY_MS = 10_000;
const ERROR_LOG_INTERVAL_MS = 60_000;

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  if (host.endsWith(".internal") || host.endsWith(".local")) return true;
  if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const match = host.match(/^172\.(\d{1,3})\./);
  return !!match && Number(match[1]) >= 16 && Number(match[1]) <= 31;
}

/** Reject credentials sent over a public plaintext Redis connection in production. */
export function validateRedisUrl(raw: string, production = process.env.NODE_ENV === "production"): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("REDIS_URL must be a valid redis:// or rediss:// URL");
  }
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error("REDIS_URL must use redis:// or rediss://");
  }
  if (production && url.protocol !== "rediss:" && !isPrivateHost(url.hostname)) {
    throw new Error("Public Redis connections must use rediss:// in production");
  }
}

function logRedisError(err: unknown): void {
  const now = Date.now();
  if (now - lastErrorLog < ERROR_LOG_INTERVAL_MS) return;
  lastErrorLog = now;
  const message = err instanceof Error ? err.message : "unknown Redis error";
  // Never log the URL: it normally contains the Redis password.
  console.error("[redis] shared store unavailable:", message);
}

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
  if (redisPromise && Date.now() < retryAfter) return redisPromise;
  if (redisPromise && retryAfter > 0 && Date.now() >= retryAfter) redisPromise = null;
  if (!redisPromise) {
    redisPromise = (async () => {
      let client: import("ioredis").default | null = null;
      try {
        validateRedisUrl(process.env.REDIS_URL as string);
        const { default: Redis } = await import("ioredis");
        client = new Redis(process.env.REDIS_URL as string, {
          // Serverless-friendly: one reused connection per warm instance, fail
          // fast if the store is unreachable, and don't spin forever on retries.
          maxRetriesPerRequest: 1,
          enableReadyCheck: true,
          enableOfflineQueue: false,
          connectTimeout: 5_000,
          commandTimeout: 5_000,
          lazyConnect: true,
        });
        client.on("error", logRedisError);
        await client.connect();
        await client.ping();
        const ready = client;
        const wrapped: RedisClient = {
          get: async <T = unknown>(key: string) => dec<T>(await ready.get(key)),
          set: (key: string, value: unknown, opts?: { ex?: number }) =>
            opts?.ex
              ? ready.set(key, enc(value), "EX", opts.ex)
              : ready.set(key, enc(value)),
          del: (key: string) => ready.del(key),
          lpush: (key: string, ...values: unknown[]) =>
            ready.lpush(key, ...values.map(enc)),
          lrange: async <T = unknown>(key: string, start: number, stop: number) =>
            (await ready.lrange(key, start, stop)).map((s) => dec<T>(s) as T),
          ltrim: (key: string, start: number, stop: number) => ready.ltrim(key, start, stop),
          zincrby: (key: string, increment: number, member: string) =>
            ready.zincrby(key, increment, member),
          incr: (key: string) => ready.incr(key),
          incrby: (key: string, increment: number) => ready.incrby(key, increment),
          expire: (key: string, seconds: number) => ready.expire(key, seconds),
          hset: (key: string, field: string, value: unknown) => ready.hset(key, field, enc(value)),
          hgetall: async <T = unknown>(key: string) => {
            const raw = await ready.hgetall(key);
            const out: Record<string, T> = {};
            for (const k of Object.keys(raw)) out[k] = dec<T>(raw[k]) as T;
            return out;
          },
          hdel: (key: string, ...fields: string[]) => ready.hdel(key, ...fields),
          hincrby: (key: string, field: string, increment: number) =>
            ready.hincrby(key, field, increment),
          hsetnx: (key: string, field: string, value: unknown) =>
            ready.hsetnx(key, field, enc(value)),
          hlen: (key: string) => ready.hlen(key),
          eval: async <T = unknown>(script: string, keys: string[], args: Array<string | number> = []) =>
            (await ready.eval(script, keys.length, ...keys, ...args.map(String))) as T,
          ping: () => ready.ping(),
        };
        retryAfter = 0;
        return wrapped;
      } catch (err) {
        logRedisError(err);
        retryAfter = Date.now() + RETRY_DELAY_MS;
        if (client) client.disconnect(false);
        return null;
      }
    })();
  }
  return redisPromise;
}

/** True when a real Redis store is configured (used to warn about the fallback). */
export function hasRedis(): boolean {
  return Boolean(process.env.REDIS_URL);
}
