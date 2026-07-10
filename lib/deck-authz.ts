// Shared per-deck authorization gate (Phase 4). Every admin MUTATION route that
// targets a single deck (replace, delete, preview, slide-meta edit) asks the same
// question — "may THIS session manage THIS slug?" — so the answer lives in one
// place instead of being re-derived (and drifting) per route.
//
// Server-only: imports getDeckOwner (a live DB read) + canManageDeck (pure).

import { getDeckOwner } from "./uploaded-decks";
import { canManageDeck, type Session } from "./auth";

// The outcome of a manage check. On failure it carries the exact HTTP status +
// error string the route should return verbatim, so callers don't re-map.
export type ManageCheck =
  | { ok: true; kind: string; ownerId: string | null }
  | { ok: false; status: 404 | 503; error: string };

/**
 * Can `session` manage the deck at `slug`? Loads the deck's owner FRESH from the
 * DB (never a cached Deck, so a just-changed owner can't be stale) and applies
 * canManageDeck.
 *
 * Per S10 we do NOT distinguish "no such deck" from "not yours": BOTH return 404,
 * so a presenter can't enumerate which slugs exist by watching for 403-vs-404.
 * Registry decks (owner_id NULL) are admin-only — exactly what canManageDeck
 * already encodes, so they need no special case here. A DB error surfaces as 503
 * (getDeckOwner throws), never a misleading 404.
 */
export async function checkDeckManage(session: Session, slug: string): Promise<ManageCheck> {
  let owner: { ownerId: string | null; kind: string } | null;
  try {
    owner = await getDeckOwner(slug);
  } catch {
    return { ok: false, status: 503, error: "database_unavailable" };
  }
  if (!owner) return { ok: false, status: 404, error: "not_found" };
  if (!canManageDeck(session, owner.ownerId)) return { ok: false, status: 404, error: "not_found" };
  return { ok: true, kind: owner.kind, ownerId: owner.ownerId };
}
