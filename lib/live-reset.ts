// The single composite purge for a deck slug's LIVE room state. One call wipes
// EVERY piece of ephemeral Redis (+ in-instance memory fallback) state keyed by a
// deck slug — slide position, presence roster, active poll + votes, Q&A queue,
// signals, pinboard, pulse counters, recap overlay, and activity card — so a deck
// can be handed a fresh room without leaving any stale live state behind.
//
// DELIBERATELY NOT TOUCHED: durable Postgres content (the `decks` row, its
// `deck_slides`, and any `deck_recaps`, `session_reports`, and `deck_assets`).
// Wiping a live session must never delete the deck, its slides, its saved
// recaps/reports, or its uploaded images — only the transient room state that
// accumulates while presenting.
//
// Best-effort by construction: every clearX helper swallows its own errors and
// never throws, and Promise.allSettled means one helper failing can neither stop
// the others nor reject this call. clearDeckLiveState therefore NEVER throws — a
// caller (the reset-session route, the deck DELETE handler) can await it with no
// guard, and a Redis hiccup can't turn a reset/delete into a 500.

import { clearSession } from "./session";
import { clearPresence } from "./presence";
import { clearPoll } from "./poll";
import { clearQna } from "./qna";
import { clearSignals } from "./signals";
import { clearPinboard } from "./pinboard";
import { clearPulse } from "./pulse";
import { clearRecap } from "./recap";
import { clearActivity } from "./activity";

/**
 * Wipe ALL live room state for `slug` — the nine ephemeral stores above — in
 * parallel, best-effort. Never throws (allSettled over self-swallowing helpers).
 */
export async function clearDeckLiveState(slug: string): Promise<void> {
  await Promise.allSettled([
    clearSession(slug),
    clearPresence(slug),
    clearPoll(slug),
    clearQna(slug),
    clearSignals(slug),
    clearPinboard(slug),
    clearPulse(slug),
    clearRecap(slug),
    clearActivity(slug),
  ]);
}
