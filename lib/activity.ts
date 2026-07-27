// Turn-and-Talk activity timer. The presenter broadcasts ONE discussion/exercise
// prompt + a synchronized countdown to every viewer; it rides the EXISTING
// /api/session poll (no new viewer request) and renders as a large card in
// parent app-chrome. Viewers count down CLIENT-SIDE from `endsAt`, so the poll
// cadence never changes — there is no per-second server traffic. "Regroup"
// (clearActivity) ends it everywhere at once. At most one activity is active per
// deck — starting a new one replaces the old (a fresh id re-shows it to viewers
// who hid the previous one). That "one record per deck" storage is the same
// lib/live-slot.ts lib/recap.ts uses: 8h TTL, in-memory fallback, never throws.

import { makeLiveSlot } from "./live-slot";
import { newId } from "./redis-util";

export type ActivityFollowUp = "poll" | "pinboard";

export interface Activity {
  id: string;
  prompt: string;
  endsAt: number; // epoch ms — viewers render the countdown client-side
  followUp: ActivityFollowUp | null;
  at: number;
}

const MAX_PROMPT = 500; // a discussion prompt, not an essay
const MIN_DURATION_S = 10;
const MAX_DURATION_S = 60 * 60; // hard cap — the UI presets are 2/5/10 min
const ENDED_GRACE_MS = 15_000; // let in-flight "time's up" renders land

// The key prefix, TTL and globalThis fallback name are the on-disk/on-instance
// format: prod Redis holds live activities under exactly these — do not drift.
const slot = makeLiveSlot<Activity>({
  keyPrefix: "live:activity",
  ttlSeconds: 60 * 60 * 8,
  memoryKey: "__liveActivityMem",
  isValid: (v): v is Activity =>
    !!v &&
    typeof (v as Activity).id === "string" &&
    typeof (v as Activity).prompt === "string" &&
    typeof (v as Activity).endsAt === "number",
});

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
  return slot.set(slug, {
    id: newId(),
    prompt: (input.prompt ?? "").toString().trim().slice(0, MAX_PROMPT),
    endsAt: Date.now() + durationSec * 1000,
    followUp: input.followUp === "poll" || input.followUp === "pinboard" ? input.followUp : null,
    at: Date.now(),
  });
}

/** The active activity for a deck, or null. An ENDED activity (past `endsAt`,
 *  with a short grace so in-flight "time's up" renders still land) is over for
 *  everyone — it's filtered here rather than re-delivered to late joiners. */
export async function getActivity(slug: string): Promise<Activity | null> {
  const activity = await slot.get(slug);
  if (activity && Date.now() > activity.endsAt + ENDED_GRACE_MS) return null;
  return activity;
}

/** Clear the active activity — the "Regroup": removes the card for every viewer
 *  at once. Best-effort. */
export const clearActivity = slot.clear;
