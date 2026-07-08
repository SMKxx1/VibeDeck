// The live presentation session — the shared state that lets one presenter drive
// many viewers across devices (slide-system-rules.md §5, extended to a server so
// it works on phones + laptop, not just one browser).
//
//   index — the presenter's current slide (0-based)
//   max   — the highest slide unlocked for viewers. Grows as the presenter shows
//           new slides; "reset lock" pins it back to the presenter's current slide.
//
// Backed by Upstash Redis when configured; otherwise an in-memory map (single
// instance only). A tiny in-instance read cache dedupes bursts of viewer polls so
// a room of phones doesn't hammer Redis.

import { getRedis } from "./redis";

export interface SessionState {
  index: number;
  max: number;
  updatedAt: number;
  /** Last time a presenter was seen (drove or heartbeat). Drives `live`. */
  seenAt: number;
}

// A session is "live" (presenter actively presenting → viewers locked/synced) if
// a presenter has been seen within this window. Otherwise viewers browse freely.
export const LIVE_WINDOW_MS = 25_000;

export function isLive(state: SessionState): boolean {
  return state.seenAt > 0 && Date.now() - state.seenAt < LIVE_WINDOW_MS;
}

const DEFAULT: SessionState = { index: 0, max: 0, updatedAt: 0, seenAt: 0 };
const keyFor = (slug: string) => `live:session:${slug}`;

// Store the in-memory fallback on globalThis so Next's dev hot-reload (which
// re-evaluates modules) doesn't wipe the live session between edits. In
// production the Redis store is the source of truth anyway.
const g = globalThis as unknown as { __liveSessionMem?: Map<string, SessionState> };
const mem = (g.__liveSessionMem ??= new Map<string, SessionState>());

const CACHE_MS = 750;
const cache = new Map<string, { at: number; state: SessionState }>();

function normalize(s: unknown): SessionState | null {
  if (!s || typeof s !== "object") return null;
  const o = s as Partial<SessionState>;
  if (typeof o.index !== "number") return null;
  return {
    index: Math.max(0, Math.floor(o.index)),
    max: Math.max(0, Math.floor(typeof o.max === "number" ? o.max : o.index)),
    updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : 0,
    seenAt: typeof o.seenAt === "number" ? o.seenAt : 0,
  };
}

/** Fresh read (bypasses the poll cache) — for presenter writes. */
async function readRaw(slug: string): Promise<SessionState> {
  const redis = await getRedis();
  if (redis) {
    try {
      const s = normalize(await redis.get<SessionState>(keyFor(slug)));
      if (s) return s;
    } catch {
      /* fall through to memory */
    }
  }
  return mem.get(slug) ?? DEFAULT;
}

async function persist(slug: string, state: SessionState): Promise<void> {
  mem.set(slug, state);
  cache.set(slug, { at: Date.now(), state });
  const redis = await getRedis();
  if (redis) {
    try {
      // 8h TTL: a session key shouldn't outlive the day it was presented.
      await redis.set(keyFor(slug), state, { ex: 60 * 60 * 8 });
    } catch {
      /* best-effort; memory still holds it for this instance */
    }
  }
}

/** Cached read — what viewers poll. */
export async function getSession(slug: string): Promise<SessionState> {
  const now = Date.now();
  const c = cache.get(slug);
  if (c && now - c.at < CACHE_MS) return c.state;
  const state = await readRaw(slug);
  cache.set(slug, { at: now, state });
  return state;
}

/** Presenter moved to `index`. Unlocks every slide up to there for viewers. */
export async function setPresenterIndex(slug: string, index: number): Promise<SessionState> {
  const prev = await readRaw(slug);
  const idx = Math.max(0, Math.floor(index));
  const now = Date.now();
  const next: SessionState = { index: idx, max: Math.max(prev.max, idx), updatedAt: now, seenAt: now };
  await persist(slug, next);
  return next;
}

/** Presenter hit "reset lock": the current slide becomes the viewer ceiling. */
export async function resetLock(slug: string): Promise<SessionState> {
  const prev = await readRaw(slug);
  const now = Date.now();
  const next: SessionState = { index: prev.index, max: prev.index, updatedAt: now, seenAt: now };
  await persist(slug, next);
  return next;
}

/** Presenter is still here — keep the session "live" without changing position. */
export async function heartbeat(slug: string): Promise<SessionState> {
  const prev = await readRaw(slug);
  const next: SessionState = { ...prev, seenAt: Date.now() };
  await persist(slug, next);
  return next;
}

/**
 * Wipe ALL live-session state for a slug: the Redis key, the poll cache, and the
 * in-instance memory fallback. Called when an uploaded deck is DELETED so a later
 * deck that happens to reuse the freed slug can't inherit a stale presenter
 * position/max. Best-effort by contract — swallows a Redis blip (memory is already
 * cleared for this instance) so it can never fail the delete that invoked it.
 */
export async function clearSession(slug: string): Promise<void> {
  mem.delete(slug);
  cache.delete(slug);
  const redis = await getRedis();
  if (redis) {
    try {
      await redis.del(keyFor(slug));
    } catch {
      /* best-effort — the memory fallback is already cleared for this instance */
    }
  }
}
