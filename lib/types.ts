// Canonical data model for the whole app.
// One shape for every slide — never invent a new structure per slide
// (slide-system-rules.md §1). All visible text lives here as real strings so it
// renders as real DOM text and can be handed to the AI sidebar as grounding.

export type SlideLayout =
  | "title" // big centered title + subtitle (deck opener)
  | "section" // section divider
  | "statement" // one big idea, centered
  | "bullets" // heading + bullet list (supports click-reveal)
  | "two-col" // heading + two labelled columns of bullets
  | "quote" // pull-quote + attribution
  | "image"; // heading + image with caption

export interface SlideImage {
  /** A file in /public (raster or SVG). Optional if `inline` is set instead. */
  src?: string;
  /**
   * Key into the inline-SVG diagram registry (components/diagrams). Renders the
   * diagram as real DOM so its labels are selectable text, not baked into an
   * image (slide-system-rules.md §§0.4, 8).
   */
  inline?: string;
  /** Required — every image has alt text (slide-system-rules.md §8). */
  alt: string;
  caption?: string;
}

export interface SlideColumn {
  heading?: string;
  bullets: string[];
}

export interface Slide {
  /** Stable, unique within the deck. */
  id: string;
  layout: SlideLayout;
  /** Small label above the title. */
  eyebrow?: string;
  title?: string;
  subtitle?: string;
  /** For `bullets`. */
  bullets?: string[];
  /** For `two-col`. */
  columns?: SlideColumn[];
  /** For `statement` / generic body copy. */
  body?: string;
  /** For `quote`. */
  quote?: string;
  attribution?: string;
  /** For `image`. */
  image?: SlideImage;
  /** If true, bullets/columns reveal one item per "next" press (click-reveal). */
  reveal?: boolean;
  /** Speaker notes — presenter view only, never rendered in the main view. */
  notes?: string;
  /** Optional accent token name, e.g. "teal" | "amber" — theme-driven, no raw colors. */
  accent?: "amber" | "teal" | "violet" | "rose";
}

// ── Branch points (choose-your-own-path decks) ───────────────────────────────
// A slide may be a BRANCH POINT: 2–4 labeled paths, each targeting a contiguous
// slide range. The presenter opens an audience vote on the paths (reusing the
// live-poll machinery — see lib/poll.ts `kind: "branch"`), reveals the tally, and
// routes the room to the winning branch (a driver-gated session jump). Persisted
// per slide in deck_slides.branches (JSONB, migration 005) alongside the other
// editable slide metadata. All indices are 0-based and inclusive.
export interface SlideBranch {
  /** What the audience votes on, e.g. "Deep-dive the API". */
  label: string;
  /** First slide of the path (0-based). Routing jumps here. */
  from: number;
  /** Last slide of the path (0-based, inclusive) — authoring/breadcrumb info. */
  to: number;
}

export const MAX_BRANCHES = 4;
export const MIN_BRANCHES = 2;
export const MAX_BRANCH_LABEL = 80;

/**
 * Validate/normalize an untrusted branch list (API body, DB JSONB, markdown
 * directive). Returns a clean 2–4 entry list, or null when the input doesn't
 * amount to a usable branch point (absent, malformed, or fewer than 2 valid
 * paths) — null is the canonical "not a branch slide". Pure + dependency-free so
 * both server stores and client editors share one rule. When `slideCount` is
 * given, entries pointing outside the deck are dropped.
 */
export function sanitizeBranches(input: unknown, slideCount?: number): SlideBranch[] | null {
  if (!Array.isArray(input)) return null;
  const out: SlideBranch[] = [];
  for (const raw of input) {
    if (out.length >= MAX_BRANCHES) break;
    if (!raw || typeof raw !== "object") continue;
    const b = raw as Partial<SlideBranch>;
    const label = typeof b.label === "string" ? b.label.trim().slice(0, MAX_BRANCH_LABEL) : "";
    if (!label) continue;
    if (typeof b.from !== "number" || !Number.isInteger(b.from) || b.from < 0) continue;
    if (typeof b.to !== "number" || !Number.isInteger(b.to) || b.to < b.from) continue;
    if (slideCount !== undefined && (b.from >= slideCount || b.to >= slideCount)) continue;
    out.push({ label, from: b.from, to: b.to });
  }
  return out.length >= MIN_BRANCHES ? out : null;
}

export interface Deck {
  /** Permanent, URL-safe identifier. The deck lives forever at /d/<slug>. */
  slug: string;
  title: string;
  /** ISO date, "YYYY-MM-DD". */
  date: string;
  description?: string;
  slides: Slide[];
  /**
   * If set, this is a self-contained HTML deck (its own engine + styles) served
   * from /public and rendered full-bleed in an iframe, instead of the React
   * slide engine. Used for pixel-faithful imported designs (e.g. a Claude Design
   * handoff). Such a deck's `slides` may be empty — use `slideCount` for the
   * library card.
   */
  embedUrl?: string;
  /** Library-card slide count when `slides` isn't the source of truth (embed decks). */
  slideCount?: number;
  /**
   * Provenance. 'registry' = a compiled in-repo deck (lib/decks/static); 'uploaded'
   * = a runtime `decks` row carrying its own HTML, served on the isolated deck
   * origin. Absent is treated as 'registry' (every existing deck). The view layer
   * MUST branch on this — an uploaded deck is rendered in a bridge-less sandboxed
   * iframe, NEVER the trusted-first-party LiveDeck/embed path.
   */
  kind?: "registry" | "uploaded";
  /**
   * For `kind: "uploaded"` only: the absolute URL on DECK_ORIGIN that serves this
   * deck's own HTML (`${DECK_ORIGIN}/d-content/<slug>`). Undefined when DECK_ORIGIN
   * is unset — the deck still lists, but as unavailable rather than crashing.
   */
  contentUrl?: string;
}
