// Shared plumbing for the three routes that mint a BRAND-NEW uploaded deck:
// upload (app/api/admin/decks), Markdown import (.../decks/import), and duplicate
// (.../decks/[slug]/duplicate).
//
// Each route keeps its own head — how the bytes arrive (JSON + 2MB cap / Markdown
// render / copy-read of the source) and what it returns on success — because those
// genuinely differ. What they must NOT differ on is slug shape, collision rules,
// and how an insert failure maps to a status: three copies of that drifting means
// a fork can mint a slug an upload would have rejected, or a race reports 500 on
// one route and 409 on another. That agreement lives here.
//
// The failure helpers return {error, status} rather than a Response so each route
// still writes its own NextResponse.json and keeps its exact body shape.

import { staticDecks } from "./decks/static";
import { deckSlugExists, insertUploadedDeck } from "./uploaded-decks";

/**
 * slug shape: lowercase alphanumeric words joined by single hyphens, no leading,
 * trailing, or doubled hyphens. Length (1–64) is bounded by the caller, since the
 * ceiling differs by context.
 */
export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Static-slug collision, checked DIRECTLY against staticDecks (not via the merged
 * getDeck): a compiled registry deck may have no DB row for an ON CONFLICT to
 * trip, and static precedence means such a slug could never render as the uploaded
 * deck anyway — so it must be rejected here, not left to the DB.
 */
export function collidesStatic(slug: string): boolean {
  return staticDecks.some((d) => d.slug === slug);
}

/**
 * title → base slug: lowercase, every non-alphanumeric run → one hyphen, trim
 * hyphens, cap length leaving room for a numeric suffix. An all-symbol title
 * yields "" — callers supply their own `|| "deck"` fallback.
 */
export function slugifyTitle(title: string): string {
  // Collapsing every maximal non-alphanumeric run to ONE hyphen means two hyphens
  // can never end up adjacent — a doubled hyphen would require two adjacent runs,
  // which by maximality is one run. So each trim below only ever has a single "-"
  // to remove, and `-` is exact where `-+` used to be. Same output for every input;
  // the difference is that `/^-+|-+$/` backtracks quadratically on a long run of
  // hyphens (CodeQL js/polynomial-redos) while an unquantified `-` cannot backtrack
  // at all. The trailing trim runs again after the slice because the 60-char cut
  // can land right after a hyphen.
  const collapsed = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return collapsed.replace(/^-/, "").replace(/-$/, "").slice(0, 60).replace(/-$/, "");
}

/**
 * today as YYYY-MM-DD — the default date so a fresh deck sorts to the TOP of the
 * newest-first library instead of last (rowToDeck coalesces a null date to "",
 * which sorts last). A client-supplied date overrides it.
 */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Auto-suffix -2/-3/… until a slug collides NOTHING (static OR any DB row). The
 * bare base is tried first (no "-1"). Bounded so a pathological namespace can't
 * spin forever; insertUploadedDeck's ON CONFLICT remains the final race guard
 * regardless. THROWS when deckSlugExists throws — a slug we couldn't prove is free
 * must fail the create, never be handed back (see allocateSlug for the mapping).
 */
export async function firstFreeSlug(base: string): Promise<string> {
  for (let n = 1; n <= 1000; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!collidesStatic(candidate) && !(await deckSlugExists(candidate))) return candidate;
  }
  return `${base}-${Date.now()}`.slice(0, 64); // astronomically unlikely to be reached
}

/** The two ways creating a deck fails for reasons the caller can't prevent. */
export interface DeckCreateFailure {
  ok: false;
  error: "database_unavailable" | "slug_conflict";
  status: 503 | 409;
}

/**
 * firstFreeSlug plus the 503 mapping every create route applied to it. Returned
 * rather than thrown so the caller's control flow stays a plain early return.
 */
export async function allocateSlug(
  base: string,
): Promise<{ ok: true; slug: string } | DeckCreateFailure> {
  try {
    return { ok: true, slug: await firstFreeSlug(base) };
  } catch {
    return { ok: false, error: "database_unavailable", status: 503 };
  }
}

/**
 * insertUploadedDeck plus the shared failure mapping: a DB error is 503, and
 * rowCount 0 (ON CONFLICT DO NOTHING — a slug that raced past allocateSlug) is a
 * 409, never a 500. The DB is the final arbiter of slug uniqueness, so this is the
 * one place that translates its verdict.
 */
export async function storeUploadedDeck(
  fields: Parameters<typeof insertUploadedDeck>[0],
): Promise<{ ok: true } | DeckCreateFailure> {
  let result: "ok" | "conflict";
  try {
    result = await insertUploadedDeck(fields);
  } catch {
    return { ok: false, error: "database_unavailable", status: 503 };
  }
  if (result === "conflict") return { ok: false, error: "slug_conflict", status: 409 };
  return { ok: true };
}
