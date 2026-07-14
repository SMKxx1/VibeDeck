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

// ---- platform-key AI token budget (a global safety cap) ---------------------
// A rolling DAILY ceiling on total platform-key token spend across every AI
// feature that bills to OUR OpenRouter key (grounding generation, quiz drafting,
// the tutor). It exists so a runaway loop or abuse can't quietly rack up cost —
// distinct from the per-name rate limit (which caps ONE user's request rate). A
// SOFT cap: checked before a call and incremented after, so a burst can overshoot
// by at most the in-flight calls, which is fine for a cost guardrail. Redis-backed
// (a shared counter across instances); with no Redis it can't be enforced, so it
// fails OPEN (the app must keep working without Redis) — the per-name limit still
// applies. Set AI_DAILY_TOKEN_BUDGET=0 to disable.
const DAILY_TOKEN_BUDGET = Number(process.env.AI_DAILY_TOKEN_BUDGET ?? 3_000_000);

function budgetKey(): string {
  // One counter per UTC day; self-expiring so old keys never accumulate.
  return `ai:budget:${new Date().toISOString().slice(0, 10)}`;
}

/** Is today's platform-key token spend still under the cap? Fails OPEN with no Redis. */
export async function checkTokenBudget(): Promise<{ allowed: boolean; used: number; cap: number }> {
  if (!DAILY_TOKEN_BUDGET || DAILY_TOKEN_BUDGET <= 0) return { allowed: true, used: 0, cap: 0 };
  const redis = await getRedis();
  if (!redis) return { allowed: true, used: 0, cap: DAILY_TOKEN_BUDGET }; // can't enforce → allow
  try {
    const used = Number(await redis.get<number>(budgetKey())) || 0;
    return { allowed: used < DAILY_TOKEN_BUDGET, used, cap: DAILY_TOKEN_BUDGET };
  } catch {
    return { allowed: true, used: 0, cap: DAILY_TOKEN_BUDGET };
  }
}

/** Add spent tokens to today's platform-key budget counter (best-effort, non-blocking). */
export async function recordBudgetTokens(tokens: number): Promise<void> {
  if (!tokens || tokens <= 0) return;
  const redis = await getRedis();
  if (!redis) return;
  try {
    const key = budgetKey();
    const n = await redis.incrby(key, tokens);
    if (n === tokens) await redis.expire(key, 60 * 60 * 48); // first write today → 48h TTL
  } catch {
    /* best-effort — never block on the budget counter */
  }
}

// ---- "Explain differently" answer cache (#10) -------------------------------
// The reframe chips (ELI5 / analogy / example / deeper) ask a FIXED question about
// a specific (deck, slide) — so the answer is reusable across every viewer in the
// room. Caching it means the 2nd..Nth tap is instant AND free (no model call, no
// budget spend). Keyed by (slug, slideIndex, mode). Stored wrapped in an object so
// a prose answer that happens to look like JSON round-trips as a string.
const EXPLAIN_TTL = 60 * 60; // 1h — slide content is stable within a session

export async function getExplainCache(key: string): Promise<string | null> {
  const redis = await getRedis();
  if (!redis) return null;
  try {
    const v = await redis.get<{ a?: string }>(`explain:${key}`);
    return v && typeof v.a === "string" ? v.a : null;
  } catch {
    return null;
  }
}

export async function setExplainCache(key: string, answer: string): Promise<void> {
  if (!answer) return;
  const redis = await getRedis();
  if (!redis) return;
  try {
    await redis.set(`explain:${key}`, { a: answer }, { ex: EXPLAIN_TTL });
  } catch {
    /* best-effort cache */
  }
}

// ---- Catch-up recap cache -----------------------------------------------------
// The "catch me up" card asks a FIXED question about a specific slide RANGE —
// (viewer's slide, live slide] — so the answer is reusable by every viewer stuck
// at the same slide. Keyed by (slug, from, to) where `to` is always the LIVE
// slide, which keeps the key space bounded: one entry per (lagging slide, live
// slide) pair, not per viewer. Same wrapped-string storage rationale as the
// explain cache above.
const CATCHUP_TTL = 60 * 60; // 1h — a session artifact, like the explain cache

export async function getCatchupCache(key: string): Promise<string | null> {
  const redis = await getRedis();
  if (!redis) return null;
  try {
    const v = await redis.get<{ a?: string }>(`catchup:${key}`);
    return v && typeof v.a === "string" ? v.a : null;
  } catch {
    return null;
  }
}

export async function setCatchupCache(key: string, answer: string): Promise<void> {
  if (!answer) return;
  const redis = await getRedis();
  if (!redis) return;
  try {
    await redis.set(`catchup:${key}`, { a: answer }, { ex: CATCHUP_TTL });
  } catch {
    /* best-effort cache */
  }
}

// ---- "Why that answer" poll-explanation cache (#3 reveal explainer) ----------
// The post-reveal explanation of a poll's correct answer is generated ONCE per
// poll and shared by the whole room (it rides the frozen poll record on the
// session poll). This cache is the cross-instance dedupe: keyed by (slug,
// pollId), so a double-reveal race or a second server instance never pays for a
// second generation. Same wrapped-string storage rationale as the explain cache.
const POLL_EXPLAIN_TTL = 60 * 60; // 1h — a session artifact, like the explain cache

export async function getPollExplainCache(key: string): Promise<string | null> {
  const redis = await getRedis();
  if (!redis) return null;
  try {
    const v = await redis.get<{ a?: string }>(`poll-explain:${key}`);
    return v && typeof v.a === "string" ? v.a : null;
  } catch {
    return null;
  }
}

export async function setPollExplainCache(key: string, answer: string): Promise<void> {
  if (!answer) return;
  const redis = await getRedis();
  if (!redis) return;
  try {
    await redis.set(`poll-explain:${key}`, { a: answer }, { ex: POLL_EXPLAIN_TTL });
  } catch {
    /* best-effort cache */
  }
}

// ---- Suggested-questions cache (#9) -----------------------------------------
// The 2-3 grounded follow-up questions shown under a slide are the same for every
// viewer on that (deck, slide), so cache them per (slug, slideIndex).
export async function getSuggestCache(key: string): Promise<string[] | null> {
  const redis = await getRedis();
  if (!redis) return null;
  try {
    const v = await redis.get<{ q?: string[] }>(`suggest:${key}`);
    return v && Array.isArray(v.q) ? v.q : null;
  } catch {
    return null;
  }
}

export async function setSuggestCache(key: string, questions: string[]): Promise<void> {
  if (!questions.length) return;
  const redis = await getRedis();
  if (!redis) return;
  try {
    await redis.set(`suggest:${key}`, { q: questions }, { ex: 60 * 60 });
  } catch {
    /* best-effort cache */
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
