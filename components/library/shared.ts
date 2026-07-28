// Dashboard pieces shared by the library shell and its modal panels — the deck
// card shape, the panel-mode union, the admin error map and the notice style.
// Moved verbatim from the old single-file components/DeckLibrary.tsx; they live
// here (rather than in the shell) so UploadPanel / ImportPanel / BootCheck can
// import them without a cycle back through the shell.

export type PublishStatus = "main" | "normal" | "unpublished";

export interface DeckCard {
  slug: string;
  title: string;
  date: string;
  description: string;
  slideCount: number;
  publishStatus: PublishStatus;
  // Present only for the first-party self-contained HTML deck. One of the two
  // ways a deck can go "Live" on "/": rendered through this same-origin iframe URL.
  embedUrl?: string;
  // The other Live path: present only for 'uploaded' decks, "/" renders them via
  // UploadedDeckFrame off this URL. Gates the "Live" segment together with embedUrl
  // — a deck with neither can never legitimately go Live (the server rejects it too).
  contentUrl?: string;
  // 'uploaded' decks are runtime DB rows the presenter created here; only they
  // are replaceable/deletable/previewable via this dashboard (registry decks
  // live in code). Undefined is treated as 'registry' — the pre-Phase-1 default.
  kind?: "registry" | "uploaded";
  // Phase 4 — may the current session manage this deck; gates the owner-only
  // overlays (edit notes, publish control, replace/delete). Undefined is treated
  // as false.
  canManage?: boolean;
}

// Which deck the one shared modal is working on: a new upload, a replacement for
// an existing uploaded deck, or a Markdown import.
export type PanelState =
  | { mode: "create" }
  | { mode: "replace"; deck: DeckCard }
  | { mode: "import" };

// Map the admin routes' failure bodies onto plain presenter-facing sentences,
// same idea as publishErrorMessage. Covers every status the POST/PUT/DELETE/
// preview handlers can return so a failure is never a bare "try again".
export function adminErrorMessage(status: number, error?: string): string {
  if (status === 401) return "Session expired — sign in again.";
  if (status === 403) return "Blocked for security — reload and retry.";
  if (status === 413 || error === "payload_too_large") return "Too large — decks are capped at 2 MB.";
  if (error === "slug_conflict") return "That slug is already taken — pick another.";
  if (error === "demote_first") return "Set this deck to Public or Hidden before deleting.";
  if (error === "not_deletable") return "This deck can't be deleted here.";
  if (error === "not_html") return "That doesn't look like HTML (no “<” found).";
  if (error === "bad_slug") return "Slug must be lowercase letters, numbers, and hyphens.";
  if (error === "missing_fields") return "Title and HTML are both required.";
  if (error === "not_found") return "Deck not found — it may have been deleted.";
  if (error === "deck_origin_unset") return "Preview isn't configured (DECK_ORIGIN unset).";
  if (status === 503 || error === "database_unavailable") return "Database unavailable.";
  return "Couldn't save — try again.";
}

// A block-level notice inside the upload panel. The validator issue list, the
// success warnings note, and every boot-check status all share this one shape so
// the panel reads as a single system. The "error" tone is byte-for-byte the
// panel's existing inline error box (see UploadPanel) — this just parameterises
// its colour by tone so ok/warn/muted variants can sit beside it without
// inventing a second visual language.
export function noticeStyle(tone: "error" | "warn" | "ok" | "muted"): React.CSSProperties {
  const palette = {
    error: { color: "#C23B27", background: "rgba(194,59,39,0.08)" },
    warn: { color: "#9A6A00", background: "rgba(180,120,0,0.10)" },
    ok: { color: "#2E8B5B", background: "rgba(46,139,91,0.10)" }, // the runtime's own pinboard-success green
    muted: { color: "#6E6A62", background: "rgba(40,38,32,0.05)" },
  }[tone];
  return {
    fontSize: 13,
    fontWeight: 500,
    lineHeight: 1.5,
    borderRadius: 10,
    padding: "8px 12px",
    ...palette,
  };
}
