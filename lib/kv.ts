// Server-only. Token tracking + per-name rate limiting for the AI sidebar.
//
// PRIVACY (slide-system-rules.md §§0.5, 9): persist ONLY
// { name, timestamp, token_count }. Never write the prompt or the answer —
// not here, not in logs, not in analytics.
//
// Redis is optional: if `REDIS_URL` is absent, tracking is skipped and the app
// still works. Uses the shared client in ./redis so there's a single connection.

import { getRedis, hasRedis } from "./redis";

function positiveInt(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

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

// ---- platform-key AI token budget (a global safety cap) ---------------------
// A rolling DAILY ceiling on total platform-key token spend across every AI
// feature that bills to OUR OpenRouter key (grounding generation, quiz drafting,
// the tutor). It exists so a runaway loop or abuse can't quietly rack up cost —
// distinct from the per-name rate limit (which caps ONE user's request rate). A
// HARD cap: every model call atomically reserves a conservative maximum before it
// starts, then reconciles that reservation to the provider's actual token count.
// Failed/disconnected calls keep their reservation, intentionally preferring a
// temporary false-positive limit over an unaccounted bill. Set the budget to 0 to
// disable only in local development; production validation rejects that setting.
const DAILY_TOKEN_BUDGET = Number(process.env.AI_DAILY_TOKEN_BUDGET ?? 3_000_000);
const BUDGET_RESERVATION = positiveInt(
  process.env.AI_TOKEN_RESERVATION,
  50_000,
  Math.max(50_000, Number.isFinite(DAILY_TOKEN_BUDGET) ? DAILY_TOKEN_BUDGET : 3_000_000),
);
const BUDGET_TTL_SECONDS = 60 * 60 * 48;

const RESERVE_BUDGET_SCRIPT = `
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local cap = tonumber(ARGV[1])
local reserve = tonumber(ARGV[2])
if used + reserve > cap then return {0, used} end
local next = redis.call('INCRBY', KEYS[1], reserve)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return {1, next}
`;

const RECONCILE_BUDGET_SCRIPT = `
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local actual = tonumber(ARGV[1])
local reserve = tonumber(ARGV[2])
local next = used + actual - reserve
if next < 0 then next = 0 end
redis.call('SET', KEYS[1], next, 'EX', tonumber(ARGV[3]))
return next
`;

function budgetKey(): string {
  // One counter per UTC day; self-expiring so old keys never accumulate.
  return `ai:budget:${new Date().toISOString().slice(0, 10)}`;
}

/** Atomically reserve capacity for one provider call. */
export async function checkTokenBudget(): Promise<{ allowed: boolean; used: number; cap: number }> {
  if (!DAILY_TOKEN_BUDGET || DAILY_TOKEN_BUDGET <= 0) return { allowed: true, used: 0, cap: 0 };
  const redis = await getRedis();
  if (!redis) {
    // Paid production calls must never run without the shared counter. Local
    // development keeps its zero-config behavior when Redis is intentionally absent.
    const failClosed = process.env.NODE_ENV === "production" && Boolean(process.env.OPENROUTER_API_KEY);
    return { allowed: !failClosed, used: 0, cap: DAILY_TOKEN_BUDGET };
  }
  try {
    const [allowed, used] = await redis.eval<[number, number]>(
      RESERVE_BUDGET_SCRIPT,
      [budgetKey()],
      [DAILY_TOKEN_BUDGET, Math.min(BUDGET_RESERVATION, DAILY_TOKEN_BUDGET), BUDGET_TTL_SECONDS],
    );
    return { allowed: allowed === 1, used: Number(used) || 0, cap: DAILY_TOKEN_BUDGET };
  } catch {
    return {
      allowed: process.env.NODE_ENV !== "production" || !process.env.OPENROUTER_API_KEY,
      used: 0,
      cap: DAILY_TOKEN_BUDGET,
    };
  }
}

/** Reconcile the current call's reservation to its actual provider usage. */
export async function recordBudgetTokens(tokens: number): Promise<void> {
  const redis = await getRedis();
  if (!redis) return;
  try {
    // Missing/invalid usage is not a refund: retain the conservative reservation.
    const actual = Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : BUDGET_RESERVATION;
    await redis.eval(
      RECONCILE_BUDGET_SCRIPT,
      [budgetKey()],
      [actual, Math.min(BUDGET_RESERVATION, DAILY_TOKEN_BUDGET), BUDGET_TTL_SECONDS],
    );
  } catch {
    /* The reservation remains charged, which is the safe failure mode. */
  }
}

// ---- AI answer caches -------------------------------------------------------
// Four caches, one mechanism: a `<prefix>:<key>` Redis entry holding a WRAPPED
// value, best-effort on both sides (a cache miss is never an error, and a store
// blip just means we pay for the answer again). The wrapper is load-bearing, not
// decoration: lib/redis.ts JSON-decodes on read, so a bare prose answer that
// happens to look like JSON would come back as an object — wrapping it in
// {a: "..."} makes it round-trip as a string. The prefix, the wrapper field name
// and the TTL ARE the on-disk format; prod Redis holds live entries shaped
// exactly this way, so none of them may change.

/** How a cached value is written to and recovered from its Redis wrapper. */
interface CacheShape<T> {
  wrap: (value: T) => unknown;
  unwrap: (stored: unknown) => T | null;
  /** Nothing worth caching — skip the write (an empty answer is not an answer). */
  isEmpty: (value: T) => boolean;
}

const ANSWER: CacheShape<string> = {
  wrap: (a) => ({ a }),
  unwrap: (stored) => {
    const v = stored as { a?: string } | null;
    return v && typeof v.a === "string" ? v.a : null;
  },
  isEmpty: (a) => !a,
};

const QUESTIONS: CacheShape<string[]> = {
  wrap: (q) => ({ q }),
  unwrap: (stored) => {
    const v = stored as { q?: string[] } | null;
    return v && Array.isArray(v.q) ? v.q : null;
  },
  isEmpty: (q) => !q.length,
};

// 1h for all four: every one of them caches a SESSION artifact keyed to slide
// content that is stable while the room is live.
const CACHE_TTL = 60 * 60;

function makeCache<T>(prefix: string, ttlSeconds: number, shape: CacheShape<T>) {
  const get = async (key: string): Promise<T | null> => {
    const redis = await getRedis();
    if (!redis) return null;
    try {
      return shape.unwrap(await redis.get(`${prefix}:${key}`));
    } catch {
      return null;
    }
  };
  const set = async (key: string, value: T): Promise<void> => {
    if (shape.isEmpty(value)) return;
    const redis = await getRedis();
    if (!redis) return;
    try {
      await redis.set(`${prefix}:${key}`, shape.wrap(value), { ex: ttlSeconds });
    } catch {
      /* best-effort cache */
    }
  };
  return { get, set };
}

// "Explain differently" (#10). The reframe chips (ELI5 / analogy / example /
// deeper) ask a FIXED question about a specific (deck, slide) — so the answer is
// reusable across every viewer in the room. Caching it means the 2nd..Nth tap is
// instant AND free (no model call, no budget spend). Keyed by (slug, slideIndex, mode).
const explainCache = makeCache("explain", CACHE_TTL, ANSWER);
export const getExplainCache = explainCache.get;
export const setExplainCache = explainCache.set;

// Catch-up recap. The "catch me up" card asks a FIXED question about a specific
// slide RANGE — (viewer's slide, live slide] — so the answer is reusable by every
// viewer stuck at the same slide. Keyed by (slug, from, to) where `to` is always
// the LIVE slide, which keeps the key space bounded: one entry per (lagging
// slide, live slide) pair, not per viewer.
const catchupCache = makeCache("catchup", CACHE_TTL, ANSWER);
export const getCatchupCache = catchupCache.get;
export const setCatchupCache = catchupCache.set;

// "Why that answer" (#3 reveal explainer). The post-reveal explanation of a
// poll's correct answer is generated ONCE per poll and shared by the whole room
// (it rides the frozen poll record on the session poll). This cache is the
// cross-instance dedupe: keyed by (slug, pollId), so a double-reveal race or a
// second server instance never pays for a second generation.
const pollExplainCache = makeCache("poll-explain", CACHE_TTL, ANSWER);
export const getPollExplainCache = pollExplainCache.get;
export const setPollExplainCache = pollExplainCache.set;

// Suggested questions (#9). The 2-3 grounded follow-up questions shown under a
// slide are the same for every viewer on that (deck, slide), so cache them per
// (slug, slideIndex).
const suggestCache = makeCache("suggest", CACHE_TTL, QUESTIONS);
export const getSuggestCache = suggestCache.get;
export const setSuggestCache = suggestCache.set;

const RATE_MAX = positiveInt(process.env.AI_RATE_LIMIT_MAX, 20, 10_000);
const RATE_WINDOW = positiveInt(process.env.AI_RATE_LIMIT_WINDOW_SECONDS, 60, 86_400);
const memBuckets = new Map<string, { count: number; resetAt: number }>();
const MAX_MEM_BUCKETS = 10_000;
let memChecks = 0;

const RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])) end
local ttl = redis.call('TTL', KEYS[1])
return {count, ttl}
`;

export interface RateLimitOptions {
  max?: number;
  windowSeconds?: number;
  /** Use for paid/public operations that are unsafe to enforce per-instance. */
  requireSharedStore?: boolean;
}

function sweepMemBuckets(now: number): void {
  memChecks += 1;
  if (memChecks % 100 !== 0 && memBuckets.size < MAX_MEM_BUCKETS) return;
  for (const [key, bucket] of memBuckets) {
    if (bucket.resetAt <= now) memBuckets.delete(key);
  }
  while (memBuckets.size >= MAX_MEM_BUCKETS) {
    const oldest = memBuckets.keys().next().value as string | undefined;
    if (!oldest) break;
    memBuckets.delete(oldest);
  }
}

/** Fixed-window limiter. Redis is atomic; the local fallback is bounded. */
export async function checkRateLimit(
  name: string,
  options: RateLimitOptions = {},
): Promise<{ allowed: boolean; retryAfter: number }> {
  const max = positiveInt(options.max?.toString(), RATE_MAX, 10_000);
  const windowSeconds = positiveInt(options.windowSeconds?.toString(), RATE_WINDOW, 86_400);

  const redis = await getRedis();
  if (redis) {
    try {
      const key = `rl:${name}`;
      const [count, ttl] = await redis.eval<[number, number]>(RATE_LIMIT_SCRIPT, [key], [windowSeconds]);
      if (Number(count) > max) {
        return { allowed: false, retryAfter: Math.max(1, Number(ttl) || windowSeconds) };
      }
      return { allowed: true, retryAfter: 0 };
    } catch {
      // A configured-but-unreachable shared limiter must not silently split into
      // per-instance limits in production.
      if (process.env.NODE_ENV === "production" || options.requireSharedStore) {
        return { allowed: false, retryAfter: windowSeconds };
      }
    }
  } else if ((hasRedis() && process.env.NODE_ENV === "production") || options.requireSharedStore) {
    return { allowed: false, retryAfter: windowSeconds };
  }

  const now = Date.now();
  sweepMemBuckets(now);
  const b = memBuckets.get(name);
  if (!b || now >= b.resetAt) {
    memBuckets.set(name, { count: 1, resetAt: now + windowSeconds * 1000 });
    return { allowed: true, retryAfter: 0 };
  }
  b.count += 1;
  if (b.count > max) {
    return { allowed: false, retryAfter: Math.ceil((b.resetAt - now) / 1000) };
  }
  return { allowed: true, retryAfter: 0 };
}
