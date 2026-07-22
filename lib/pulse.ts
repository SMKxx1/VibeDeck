// Confusion pulse (Insight Engine): content-free per-(slide,signal) counters
// that power the presenter's live "where is the room struggling" heat strip and
// the end-of-session AI debrief snapshot.
//
// STRICT PRIVACY: nothing here ever stores WHO struggled or WHAT they asked —
// only that on slide N a struggle signal of a given kind happened. Counts only.
//
// Storage: one Redis HASH per deck (`live:pulse:{slug}`) with fields
// `{slideIndex}:{event}` → count, incremented via HINCRBY so concurrent viewer
// signals are per-field atomic (never a lost-update read-modify-write). A
// `startedAt` meta field (HSETNX — written exactly once, never colliding with
// the numeric field pattern) records when this run's counting began, so a saved
// session report can carry a start time. Same Redis conventions as lib/recap.ts
// / lib/poll.ts: 8h TTL (refreshed on write — a session key shouldn't outlive
// the day it was presented), in-memory fallback, best-effort — NEVER throws.
// Every bump call site is fire-and-forget (`void bumpPulse(...).catch(...)`) so
// counting can never slow down or fail the response it rides on.

import { getRedis } from "./redis";

/** The struggle signals the heat strip counts (content-free by construction). */
export type PulseEvent = "ask" | "explain" | "catchup" | "lost" | "poll_wrong";

const PULSE_EVENTS: PulseEvent[] = ["ask", "explain", "catchup", "lost", "poll_wrong"];

/** One slide's aggregate struggle counts (only numeric aggregates, ever). */
export interface PulseSlide {
  index: number;
  ask: number;
  explain: number;
  catchup: number;
  lost: number;
  pollWrong: number;
  total: number;
}

/** What getPulse returns — the tidy structure the console renders directly. */
export interface PulseAggregates {
  /** When this run's counting began (first bump), or null before any signal. */
  startedAt: number | null;
  /** Slides with at least one signal, ascending by index. */
  slides: PulseSlide[];
}

const keyFor = (slug: string) => `live:pulse:${slug}`;
const TTL_S = 60 * 60 * 8;
const START_FIELD = "startedAt"; // never matches the `{index}:{event}` pattern
// Hard ceiling on the slide index: a real deck never has thousands of slides, so
// anything beyond this is a hostile/garbage index. Bounding it here (no caller can
// exceed it) keeps the Redis hash AND the in-memory shadow Map from growing without
// bound when a viewer sends indices 0,1,…,1e9.
const MAX_SLIDE_INDEX = 5000;

// Persist the in-memory fallback across dev hot-reloads (see lib/recap.ts).
interface MemPulse {
  startedAt: number;
  counts: Map<string, number>; // `{index}:{event}` → count, mirroring the hash
}
const g = globalThis as unknown as { __livePulseMem?: Map<string, MemPulse> };
const mem = (g.__livePulseMem ??= new Map<string, MemPulse>());

function fieldFor(slideIndex: number, event: PulseEvent): string {
  return `${slideIndex}:${event}`;
}

/**
 * Count one struggle signal (or `count` of them, e.g. wrong poll votes) against
 * a slide. Best-effort by contract: swallows every failure so a fire-and-forget
 * call site can never be affected. The slide index is floored/clamped here so a
 * garbage index can never mint a weird hash field.
 */
export async function bumpPulse(
  slug: string,
  slideIndex: number,
  event: PulseEvent,
  count = 1,
): Promise<void> {
  if (!slug || !Number.isFinite(slideIndex)) return;
  const idx = Math.max(0, Math.floor(slideIndex));
  if (idx > MAX_SLIDE_INDEX) return; // out-of-range index: never mint a hash field/Map entry for it
  const n = Math.floor(count);
  if (!Number.isFinite(n) || n <= 0) return;
  const field = fieldFor(idx, event);

  // In-memory shadow first (this instance's fallback if Redis is absent/blips).
  let m = mem.get(slug);
  if (!m) {
    m = { startedAt: Date.now(), counts: new Map() };
    mem.set(slug, m);
  }
  m.counts.set(field, (m.counts.get(field) ?? 0) + n);

  const redis = await getRedis();
  if (redis) {
    try {
      const key = keyFor(slug);
      await redis.hincrby(key, field, n);
      await redis.hsetnx(key, START_FIELD, Date.now()); // first bump only
      await redis.expire(key, TTL_S);
    } catch {
      /* best-effort — the memory shadow already holds it for this instance */
    }
  }
}

// Fold a flat `{field: count}` record into the per-slide aggregate shape.
function aggregate(raw: Record<string, number>): PulseAggregates {
  const bySlide = new Map<number, PulseSlide>();
  let startedAt: number | null = null;
  for (const [field, value] of Object.entries(raw)) {
    const count = Number(value);
    if (!Number.isFinite(count) || count <= 0) continue;
    if (field === START_FIELD) {
      startedAt = count;
      continue;
    }
    const sep = field.indexOf(":");
    if (sep <= 0) continue;
    const idx = Number(field.slice(0, sep));
    const event = field.slice(sep + 1) as PulseEvent;
    if (!Number.isInteger(idx) || idx < 0 || !PULSE_EVENTS.includes(event)) continue;
    let s = bySlide.get(idx);
    if (!s) {
      s = { index: idx, ask: 0, explain: 0, catchup: 0, lost: 0, pollWrong: 0, total: 0 };
      bySlide.set(idx, s);
    }
    if (event === "ask") s.ask += count;
    else if (event === "explain") s.explain += count;
    else if (event === "catchup") s.catchup += count;
    else if (event === "lost") s.lost += count;
    else s.pollWrong += count;
    s.total += count;
  }
  const slides = Array.from(bySlide.values()).sort((a, b) => a.index - b.index);
  return { startedAt, slides };
}

/** The per-slide struggle aggregates for a deck. Empty (never throws) on failure. */
export async function getPulse(slug: string): Promise<PulseAggregates> {
  const redis = await getRedis();
  if (redis) {
    try {
      const raw = await redis.hgetall<number>(keyFor(slug));
      // An empty hash could mean "no signals yet" OR "Redis has it but this
      // instance also bumped in-memory"; prefer any real Redis content, fall
      // back to memory only when the hash is genuinely empty.
      if (Object.keys(raw).length > 0) return aggregate(raw);
    } catch {
      /* fall through to memory */
    }
  }
  const m = mem.get(slug);
  if (!m) return { startedAt: null, slides: [] };
  const raw: Record<string, number> = { [START_FIELD]: m.startedAt };
  for (const [field, count] of m.counts) raw[field] = count;
  return aggregate(raw);
}

/** Reset the counters (after a debrief snapshot, so repeat runs start fresh). */
export async function clearPulse(slug: string): Promise<void> {
  mem.delete(slug);
  const redis = await getRedis();
  if (redis) {
    try {
      await redis.del(keyFor(slug));
    } catch {
      /* best-effort */
    }
  }
}
