// Server-only. Token tracking + per-name rate limiting for the AI sidebar.
//
// PRIVACY (slide-system-rules.md §§0.5, 9): persist ONLY
// { name, timestamp, token_count }. Never write the prompt or the answer —
// not here, not in logs, not in analytics.
//
// Redis is optional: if `REDIS_URL` is absent, tracking is skipped and the app
// still works. Uses the shared client in ./redis so there's a single connection.

import { getRedis } from "./redis";

/** Increment a name's running token total and append a privacy-safe event. */
export async function recordTokens(name: string, tokens: number): Promise<void> {
  if (!tokens || tokens <= 0) return;
  const redis = await getRedis();
  if (!redis) return; // no store configured — skip silently
  try {
    await redis.zincrby("tokens:by-name", tokens, name);
    // The ONLY three fields we are ever allowed to persist.
    const event = JSON.stringify({ name, timestamp: Date.now(), token_count: tokens });
    await redis.lpush("ai:events", event);
    await redis.ltrim("ai:events", 0, 4999); // keep the log bounded
  } catch {
    /* best-effort: never block the answer, never log the payload */
  }
}

const RATE_MAX = Number(process.env.AI_RATE_LIMIT_MAX ?? 20);
const RATE_WINDOW = Number(process.env.AI_RATE_LIMIT_WINDOW_SECONDS ?? 60);
const memBuckets = new Map<string, { count: number; resetAt: number }>();

/** Per-name fixed-window rate limit. Uses Redis when available, else memory. */
export async function checkRateLimit(
  name: string,
): Promise<{ allowed: boolean; retryAfter: number }> {
  if (!RATE_MAX || RATE_MAX <= 0) return { allowed: true, retryAfter: 0 };

  const redis = await getRedis();
  if (redis) {
    try {
      const key = `rl:${name}`;
      const n = await redis.incr(key);
      if (n === 1) await redis.expire(key, RATE_WINDOW);
      if (n > RATE_MAX) return { allowed: false, retryAfter: RATE_WINDOW };
      return { allowed: true, retryAfter: 0 };
    } catch {
      /* fall through to in-memory */
    }
  }

  const now = Date.now();
  const b = memBuckets.get(name);
  if (!b || now > b.resetAt) {
    memBuckets.set(name, { count: 1, resetAt: now + RATE_WINDOW * 1000 });
    return { allowed: true, retryAfter: 0 };
  }
  b.count += 1;
  if (b.count > RATE_MAX) {
    return { allowed: false, retryAfter: Math.ceil((b.resetAt - now) / 1000) };
  }
  return { allowed: true, retryAfter: 0 };
}
