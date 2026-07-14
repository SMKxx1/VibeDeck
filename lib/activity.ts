// Turn-and-Talk activity timer. The presenter broadcasts ONE discussion/exercise
// prompt + a synchronized countdown to every viewer; it rides the EXISTING
// /api/session poll (no new viewer request) and renders as a large card in
// parent app-chrome. Viewers count down CLIENT-SIDE from `endsAt`, so the poll
// cadence never changes — there is no per-second server traffic. "Regroup"
// (clearActivity) ends it everywhere at once. At most one activity is active per
// deck — starting a new one replaces the old (a fresh id re-shows it to viewers
// who hid the previous one). Same Redis conventions as lib/recap.ts /
// lib/signals.ts: 8h TTL, in-memory fallback, best-effort — never throws.

import { randomBytes } from "crypto";
import { getRedis } from "./redis";

export type ActivityFollowUp = "poll" | "pinboard";

export interface Activity {
  id: string;
  prompt: string;
  endsAt: number; // epoch ms — viewers render the countdown client-side
  followUp: ActivityFollowUp | null;
  at: number;
}

const keyFor = (slug: string) => `live:activity:${slug}`;
const TTL_S = 60 * 60 * 8;
const MAX_PROMPT = 500; // a discussion prompt, not an essay
const MIN_DURATION_S = 10;
const MAX_DURATION_S = 60 * 60; // hard cap — the UI presets are 2/5/10 min

// Persist the in-memory fallback across dev hot-reloads (see lib/pinboard.ts).
const g = globalThis as unknown as { __liveActivityMem?: Map<string, Activity> };
const mem = (g.__liveActivityMem ??= new Map<string, Activity>());

function newId(): string {
  return randomBytes(9).toString("base64url");
}

/** Start (or replace) the active activity for a deck. `endsAt` is computed HERE,
 *  at write time, so every viewer counts down to the same wall-clock instant. */
export async function setActivity(
  slug: string,
  input: { prompt: string; durationSec: number; followUp?: ActivityFollowUp | null },
): Promise<Activity> {
  const durationSec = Math.min(
    MAX_DURATION_S,
    Math.max(MIN_DURATION_S, Math.floor(Number(input.durationSec)) || 0),
  );
  const activity: Activity = {
    id: newId(),
    prompt: (input.prompt ?? "").toString().trim().slice(0, MAX_PROMPT),
    endsAt: Date.now() + durationSec * 1000,
    followUp: input.followUp === "poll" || input.followUp === "pinboard" ? input.followUp : null,
    at: Date.now(),
  };
  mem.set(slug, activity);
  const redis = await getRedis();
  if (redis) {
    try {
      await redis.set(keyFor(slug), activity, { ex: TTL_S });
    } catch {
      /* best-effort */
    }
  }
  return activity;
}

/** The active activity for a deck, or null. An ENDED activity (past `endsAt`,
 *  with a short grace so in-flight "time's up" renders still land) is over for
 *  everyone — it's filtered here rather than re-delivered to late joiners. */
export async function getActivity(slug: string): Promise<Activity | null> {
  let activity: Activity | null = null;
  const redis = await getRedis();
  if (redis) {
    try {
      const a = await redis.get<Activity>(keyFor(slug));
      activity =
        a && typeof a.id === "string" && typeof a.prompt === "string" && typeof a.endsAt === "number"
          ? a
          : null;
    } catch {
      activity = mem.get(slug) ?? null;
    }
  } else {
    activity = mem.get(slug) ?? null;
  }
  if (activity && Date.now() > activity.endsAt + 15_000) return null;
  return activity;
}

/** Clear the active activity — the "Regroup": removes the card for every viewer
 *  at once. Best-effort. */
export async function clearActivity(slug: string): Promise<void> {
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
