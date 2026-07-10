"use client";

// The deck library / dashboard — a faithful port of the Claude Design handoff
// "Deck Library.dc.html" (the "Lumen" concept), fixed to the warm-light "Solis"
// palette (the dark "Lunae" toggle branch is intentionally dropped).
//
// Layout: a hero (greeting + orbital stat motif + resume strip) beside a bento
// grid of gradient deck cards, over a warm paper + dot-grid + grain background,
// with a left nav rail and a top bar (search + avatar). Real decks fill the
// prominent bento slots newest-first; design sample cards complete the grid so
// it always reads as full. Typing in search swaps to a filtered results grid.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

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

// ---- publish-status control wiring ------------------------------------------

// Lifted to the DeckLibrary root and threaded by context (not props) on purpose:
// the /api/admin/publish POST returns the FULL statusMap, and a single promote-
// to-'main' DEMOTES the previous main — that demotion has to repaint the OTHER
// card with no page reload. Five structurally-different bento cards plus the
// search grid all need the same live status; none of them is a natural prop-
// drilling spine, so a context is the cleanest shared channel.
interface PublishCtxValue {
  statusOf: (slug: string) => PublishStatus;
  isSaving: (slug: string) => boolean;
  errorOf: (slug: string) => string | null;
  // Whether this deck may be featured on "/" (Live). Keyed by slug like the
  // others so every card can ask without prop-drilling embedUrl through the bento.
  embeddableOf: (slug: string) => boolean;
  setStatus: (slug: string, status: PublishStatus) => void;
}
const PublishCtx = createContext<PublishCtxValue | null>(null);
function usePublish(): PublishCtxValue | null {
  return useContext(PublishCtx);
}

// ---- uploaded-deck admin wiring ---------------------------------------------

// The upload panel is a single shared modal lifted to the DeckLibrary root, not
// one-per-card: only ever one is open, and the "New deck" tile (bottom-right of
// the bento) sits far from any given card's "Replace" pill, so prop-drilling a
// setter through five structurally-different cards + the search grid would be
// noise. A context is the same shared-channel choice PublishCtx already makes.
// `refresh` re-runs the server component (dashboard reads listDecks() server-
// side) so a create/replace/delete repaints the grid with no full reload.
type PanelState =
  | { mode: "create" }
  | { mode: "replace"; deck: DeckCard }
  | { mode: "import" };
interface AdminCtxValue {
  openCreate: () => void;
  openReplace: (deck: DeckCard) => void;
  openImport: () => void;
  refresh: () => void;
}
const AdminCtx = createContext<AdminCtxValue | null>(null);
function useAdmin(): AdminCtxValue | null {
  return useContext(AdminCtx);
}

// Map the admin routes' failure bodies onto plain presenter-facing sentences,
// same idea as publishErrorMessage. Covers every status the POST/PUT/DELETE/
// preview handlers can return so a failure is never a bare "try again".
function adminErrorMessage(status: number, error?: string): string {
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

// The Markdown-import route (/api/admin/decks/import) has its own failure copy —
// its size cap (~400 KB vs the upload path's 2 MB) and slug-conflict wording are
// import-specific — so it gets a sibling of adminErrorMessage rather than reusing
// it. Covers every status the import handler documents.
function importErrorMessage(status: number, error?: string): string {
  if (error === "empty_markdown") return "Paste some Markdown first.";
  if (status === 413 || error === "payload_too_large") return "That's too large — keep it under ~400 KB.";
  if (error === "invalid_deck") return "Couldn't build a valid deck from that Markdown.";
  if (error === "slug_conflict") return "A deck with that name exists — try a different title.";
  if (status === 401) return "Session expired — sign in again.";
  if (status === 403) return "Blocked for security — reload.";
  if (status === 503 || error === "database_unavailable") return "Database unavailable.";
  return "Couldn't import — try again.";
}

// The three publish states, in escalating-visibility order (Live > Public >
// Hidden). Titles double as the affordance's hover explanation.
const PUBLISH_SEGMENTS: { key: PublishStatus; label: string; title: string; aria: string }[] = [
  {
    key: "main",
    label: "Live",
    title: "Feature on the home page ( / ). Replaces whatever is live there now.",
    aria: "Set as the live deck shown on the home page",
  },
  {
    key: "normal",
    label: "Public",
    title: "Public at its own /d/ link, but not on the home page.",
    aria: "Make public at its own link",
  },
  {
    key: "unpublished",
    label: "Hidden",
    title: "Only presenters can open it; anyone else gets a 404.",
    aria: "Hide from everyone but presenters",
  },
];

// Map the API's failure modes onto the same idle/saving/saved/error feel as
// SlideMetaEditor's per-card Save, so the two presenter tools read consistently.
function publishErrorMessage(status: number, error?: string): string {
  if (status === 401) return "Session expired — sign in again.";
  if (status === 503 || error === "database_unavailable") return "Database unavailable.";
  // Defensive: the server refused to feature a non-embed deck on "/". The "Live"
  // segment is disabled for these, so this only surfaces if the guard is somehow
  // reached anyway (or an existing bad 'main' is re-clicked) — fail loud, not silent.
  if (error === "not_embeddable") return "This deck can't be shown on the home page.";
  return "Couldn't update — try again.";
}

// The active segment's fill IS the status badge: bright lime for Live (the
// "LIVE ON /" signal), a light chip for Public, a dark chip + lock for Hidden.
// Inactive segments are muted, tinted for the card surface they overlay (dark
// frosted overlay vs. light inline search card).
function segStyle(kind: PublishStatus, active: boolean, overlay: boolean, blocked: boolean): React.CSSProperties {
  const base: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    height: 24,
    padding: active ? "0 9px" : "0 7px",
    borderRadius: 7,
    border: "none",
    fontFamily: "inherit",
    fontSize: 11.5,
    fontWeight: active ? 600 : 500,
    cursor: active ? "default" : "pointer",
    whiteSpace: "nowrap",
    background: "transparent",
    color: overlay ? "rgba(255,255,255,0.72)" : "#8A857C",
    transition: "background .15s, color .15s",
  };
  // Blocked implies inactive (an already-'main' non-embed deck is left looking
  // Live so it reflects reality). Keep the segment visible but visibly
  // unavailable — dimmed + not-allowed — so it reads as "exists, just not here".
  if (blocked) return { ...base, opacity: 0.38, cursor: "not-allowed" };
  if (!active) return base;
  if (kind === "main") return { ...base, background: "#BFE048", color: "#2C2A31" };
  if (kind === "unpublished") {
    return { ...base, background: overlay ? "rgba(20,18,16,0.72)" : "rgba(44,42,49,0.85)", color: "#F4F2EC" };
  }
  return { ...base, background: overlay ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.95)", color: "#2C2A31" };
}

function statusLineStyle(overlay: boolean, isError: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    maxWidth: 220,
    padding: "3px 8px",
    borderRadius: 7,
    fontSize: 11,
    fontWeight: 500,
    lineHeight: 1.25,
    background: overlay ? "rgba(30,28,26,0.42)" : "rgba(40,38,32,0.05)",
    color: isError ? (overlay ? "#FFC7BC" : "#C23B27") : overlay ? "rgba(255,255,255,0.86)" : "#6E6A62",
    backdropFilter: overlay ? "blur(8px)" : undefined,
    WebkitBackdropFilter: overlay ? "blur(8px)" : undefined,
  };
}

// A block-level notice inside the upload panel. The validator issue list, the
// success warnings note, and every boot-check status all share this one shape so
// the panel reads as a single system. The "error" tone is byte-for-byte the
// panel's existing inline error box (see UploadPanel) — this just parameterises
// its colour by tone so ok/warn/muted variants can sit beside it without
// inventing a second visual language.
function noticeStyle(tone: "error" | "warn" | "ok" | "muted"): React.CSSProperties {
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

function SegIcon({ kind }: { kind: PublishStatus }) {
  if (kind === "main") {
    return (
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
        <circle cx="6" cy="6" r="2.6" fill="currentColor" />
        <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1" opacity="0.5" />
      </svg>
    );
  }
  if (kind === "normal") {
    return (
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.1">
        <circle cx="6" cy="6" r="4.6" />
        <path d="M1.4 6h9.2M6 1.4c1.7 1.3 1.7 7.9 0 9.2M6 1.4c-1.7 1.3-1.7 7.9 0 9.2" />
      </svg>
    );
  }
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.1">
      <rect x="2.6" y="5.4" width="6.8" height="5" rx="1.1" />
      <path d="M4.1 5.4V4a1.9 1.9 0 0 1 3.8 0v1.4" />
    </svg>
  );
}

// A presenter-only 3-state publish control. `overlay` mode is an absolute
// top-left sibling of a bento card's <Link> (never nested — nested anchors are
// invalid HTML, same rule EditPill follows); `inline` mode sits under a search
// result card. stopPropagation keeps a click from also triggering the card link.
function PublishControl({ slug, isAdmin, variant = "overlay" }: { slug: string; isAdmin: boolean; variant?: "overlay" | "inline" }) {
  const ctx = usePublish();
  if (!ctx) return null;
  const status = ctx.statusOf(slug);
  const saving = ctx.isSaving(slug);
  const error = ctx.errorOf(slug);
  // "/" can only render a main deck via Deck.embedUrl's iframe, so a deck without
  // one can never go Live — that segment is disabled below (server enforces it too).
  const embeddable = ctx.embeddableOf(slug);
  const overlay = variant === "overlay";
  const showLine = saving || !!error || status === "unpublished";

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={
        overlay
          ? { position: "absolute", top: 10, left: 10, zIndex: 3, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6 }
          : { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6, marginTop: 12 }
      }
    >
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 2,
          padding: 3,
          borderRadius: 10,
          opacity: saving ? 0.7 : 1,
          background: overlay ? "rgba(30,28,26,0.38)" : "rgba(40,38,32,0.05)",
          border: overlay ? "1px solid rgba(255,255,255,0.32)" : "1px solid rgba(60,55,45,0.14)",
          backdropFilter: overlay ? "blur(8px)" : undefined,
          WebkitBackdropFilter: overlay ? "blur(8px)" : undefined,
        }}
      >
        {PUBLISH_SEGMENTS.map((seg) => {
          const active = seg.key === status;
          // Disable the Live segment when it isn't already active (an existing bad
          // 'main' stays shown as Live so it mirrors the DB). Two independent
          // reasons block it: the deck type can't be shown on "/" (non-embed), OR
          // the current session isn't an admin (only admins may feature on "/").
          // A blocked segment is left visible, not hidden, so the option still
          // reads as real — just unavailable here.
          const blockedEmbed = seg.key === "main" && !embeddable && !active;
          const blockedAdmin = seg.key === "main" && !isAdmin && !active;
          const blocked = blockedEmbed || blockedAdmin;
          const disabled = saving || blocked;
          return (
            <button
              key={seg.key}
              type="button"
              title={
                blockedEmbed
                  ? "This deck type can't be shown on the home page ( / ) — only self-contained HTML decks can go Live."
                  : blockedAdmin
                    ? "Only an admin can feature a deck on the home page ( / )."
                    : seg.title
              }
              aria-label={seg.aria}
              aria-pressed={active}
              aria-disabled={blocked || undefined}
              disabled={disabled}
              onClick={() => {
                if (!active && !disabled) ctx.setStatus(slug, seg.key);
              }}
              className={active || blocked ? undefined : overlay ? "lm-pub-seg-o" : "lm-pub-seg-i"}
              style={segStyle(seg.key, active, overlay, blocked)}
            >
              <SegIcon kind={seg.key} />
              {active && <span>{seg.label}</span>}
            </button>
          );
        })}
      </div>
      {showLine && (
        <span style={statusLineStyle(overlay, !!error && !saving)}>
          {!saving && !error && status === "unpublished" && <SegIcon kind="unpublished" />}
          {saving ? "Saving…" : error ? error : "Only you can see this."}
        </span>
      )}
    </div>
  );
}

// The dashed outline drawn OVER an unpublished card. It's a sibling of the card
// (not the card's own border) so it stays crisp even though the card itself is
// desaturated — signalling "this isn't public" at a glance.
function hiddenOutlineStyle(radius: number): React.CSSProperties {
  return {
    position: "absolute",
    inset: 0,
    borderRadius: radius,
    border: "2px dashed rgba(44,42,49,0.4)",
    pointerEvents: "none",
    zIndex: 1,
  };
}

const NAME_KEY = "presentation:name";

const NUMBER_WORDS = [
  "No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve",
];
function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

// Design sample decks used only to complete the bento grid when the real
// library has fewer than five decks. Decorative — they don't link anywhere.
interface SampleDeck {
  title: string;
  meta: string;
  slideCount: number;
}
const SAMPLE_DECKS: SampleDeck[] = [
  { title: "The French Revolution in 12 Minutes", meta: "Seminar", slideCount: 12 },
  { title: "Photosynthesis, Visually", meta: "Lecture 3", slideCount: 9 },
];

// ---- shared card chrome -----------------------------------------------------

function ArrowGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="rgba(255,255,255,0.9)"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4.5 11.5L11.5 4.5M6 4.5h5.5V10" />
    </svg>
  );
}

// ---- generative motifs (verbatim from the design) ---------------------------

function WaveformMotif() {
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: "48%",
        transform: "translateY(-50%)",
        display: "flex",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      <svg
        width="92%"
        height="170"
        viewBox="0 0 520 170"
        fill="none"
        preserveAspectRatio="xMidYMid meet"
        style={{ overflow: "visible" }}
      >
        <line x1="28" y1="120" x2="492" y2="120" stroke="rgba(255,255,255,0.28)" strokeWidth={1} />
        <g stroke="rgba(255,255,255,0.62)" strokeWidth={1} vectorEffect="non-scaling-stroke">
          <path d="M28 120 C 150 30 300 60 360 86 C 420 108 470 96 492 72" />
          <path d="M28 120 C 150 72 300 150 360 108 C 420 80 470 60 492 72" />
          <path d="M28 120 C 162 22 280 168 380 120 C 440 92 472 82 492 72" />
          <path d="M28 120 C 140 110 300 30 372 80 C 430 118 470 104 492 72" />
          <path d="M28 120 C 172 150 290 40 360 104 C 420 150 470 70 492 72" />
        </g>
        <circle cx="28" cy="120" r="5.5" fill="#FFFFFF" />
        <circle cx="492" cy="72" r="6.5" fill="#CBE94A" />
      </svg>
    </div>
  );
}

function SphereMotifRight() {
  return (
    <div
      style={{
        position: "absolute",
        right: 14,
        top: "50%",
        transform: "translateY(-50%)",
        pointerEvents: "none",
        opacity: 0.9,
      }}
    >
      <svg width="118" height="118" viewBox="0 0 120 120" fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth={1} vectorEffect="non-scaling-stroke">
        <circle cx="60" cy="60" r="50" />
        <ellipse cx="60" cy="60" rx="40" ry="50" />
        <ellipse cx="60" cy="60" rx="24" ry="50" />
        <ellipse cx="60" cy="60" rx="50" ry="28" />
        <circle cx="60" cy="60" r="3.5" fill="#CBE94A" stroke="none" />
      </svg>
    </div>
  );
}

function VortexMotif() {
  return (
    <div style={{ position: "absolute", left: "50%", top: "46%", transform: "translate(-50%,-50%)", pointerEvents: "none" }}>
      <svg width="150" height="190" viewBox="0 0 170 210" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth={1} vectorEffect="non-scaling-stroke">
        <ellipse cx="96" cy="34" rx="68" ry="11" />
        <ellipse cx="92" cy="52" rx="60" ry="10" />
        <ellipse cx="89" cy="70" rx="52" ry="9" />
        <ellipse cx="86" cy="88" rx="44" ry="8.5" />
        <ellipse cx="84" cy="106" rx="36" ry="8" />
        <ellipse cx="82" cy="124" rx="28" ry="7" />
        <ellipse cx="81" cy="142" rx="21" ry="6" />
        <ellipse cx="80" cy="160" rx="14" ry="5" />
        <ellipse cx="80" cy="176" rx="8" ry="4" />
        <circle cx="80" cy="176" r="3.6" fill="#CBE94A" stroke="none" />
      </svg>
    </div>
  );
}

function ArcMotif() {
  return (
    <div style={{ position: "absolute", left: 14, right: 14, top: 42, pointerEvents: "none" }}>
      <svg width="100%" height="48" viewBox="0 0 200 56" preserveAspectRatio="xMidYMid meet" fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth={1} vectorEffect="non-scaling-stroke">
        <path d="M14 52 Q 100 -6 186 52" />
        <path d="M14 52 Q 100 12 186 52" />
        <path d="M14 52 Q 100 30 186 52" />
        <circle cx="14" cy="52" r="3.4" fill="#CBE94A" stroke="none" />
      </svg>
    </div>
  );
}

function SphereMotifInline() {
  return (
    <div style={{ position: "relative", pointerEvents: "none", opacity: 0.9, flex: "0 0 auto" }}>
      <svg width="116" height="100" viewBox="0 0 120 104" fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth={1} vectorEffect="non-scaling-stroke">
        <ellipse cx="60" cy="52" rx="50" ry="44" />
        <ellipse cx="60" cy="52" rx="38" ry="44" />
        <ellipse cx="60" cy="52" rx="22" ry="44" />
        <ellipse cx="60" cy="52" rx="50" ry="26" />
        <circle cx="60" cy="52" r="3.6" fill="#CBE94A" stroke="none" />
      </svg>
    </div>
  );
}

const NOISE_OVERLAY =
  "url('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22120%22 height=%22120%22%3E%3Cfilter id=%22g%22%3E%3CfeTurbulence type=%22fractalNoise%22 baseFrequency=%220.85%22 numOctaves=%222%22/%3E%3C/filter%3E%3Crect width=%22120%22 height=%22120%22 filter=%22url(%23g)%22/%3E%3C/svg%3E')";

function CardNoise() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        backgroundImage: NOISE_OVERLAY,
        opacity: 0.08,
        mixBlendMode: "overlay",
        pointerEvents: "none",
      }}
    />
  );
}

// A frosted "Edit notes & AI" pill anchored to a card. Rendered as a SIBLING of
// the card's <Link> (never nested inside it — nested anchors are invalid HTML)
// and links to the presenter-only editor.
function EditPill({ href }: { href: string }) {
  return (
    <Link
      href={href}
      className="lm-edit"
      title="Edit speaker notes & AI context"
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        bottom: 10,
        right: 10,
        zIndex: 2,
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        height: 26,
        padding: "0 10px",
        borderRadius: 9,
        background: "rgba(30,28,26,0.34)",
        border: "1px solid rgba(255,255,255,0.35)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        color: "rgba(255,255,255,0.95)",
        fontSize: 11.5,
        fontWeight: 500,
        textDecoration: "none",
        whiteSpace: "nowrap",
      }}
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
        <path d="M11.5 2.5l2 2L6 12l-2.5.5L4 10z" />
      </svg>
      Edit notes &amp; AI
    </Link>
  );
}

// A bento card — links to /d/<slug> when real, decorative otherwise. Real cards
// also get an EditPill overlay linking to the editor and, when `publishSlug` is
// set, a 3-state publish control. An unpublished deck's card is desaturated and
// dashed-outlined so it visibly reads as not-public.
function BentoCard(props: {
  href?: string;
  editHref?: string;
  publishSlug?: string;
  // Set only for uploaded (DB-backed) decks — drives the Replace/Delete/Preview
  // overlay. Registry/sample cards leave it undefined and show none of those.
  uploaded?: DeckCard;
  // Phase 4 — may the current session manage this deck? Gates the interactive
  // owner-only overlays (EditPill / PublishControl / UploadedActions). Note that
  // `publishSlug` is still threaded even when this is false so the card's own
  // hidden/desaturation styling reflects the live status; only the interactive
  // controls are withheld.
  canManage?: boolean;
  // Admin-only "Live" segment gating — forwarded to PublishControl.
  isAdmin?: boolean;
  gridColumn: string;
  gridRow: string;
  background: string;
  boxShadow: string;
  radius?: number;
  children: React.ReactNode;
}) {
  const { href, editHref, publishSlug, uploaded, canManage, isAdmin, gridColumn, gridRow, background, boxShadow, radius = 22, children } = props;
  const ctx = usePublish();
  const status = publishSlug && ctx ? ctx.statusOf(publishSlug) : "normal";
  const hidden = status === "unpublished";
  const cardStyle: React.CSSProperties = {
    position: "relative",
    width: "100%",
    height: "100%",
    borderRadius: radius,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    background,
    boxShadow,
    textDecoration: "none",
    color: "inherit",
    // Desaturate an unpublished card. Applied to the card only — the overlay
    // controls are siblings, so they stay full-contrast and legible.
    filter: hidden ? "saturate(0.6) brightness(0.98)" : undefined,
    transition: "transform .18s cubic-bezier(.2,.6,.2,1), box-shadow .18s cubic-bezier(.2,.6,.2,1)",
  };
  const card = href ? (
    <Link href={href} style={cardStyle} className="lm-card">
      {children}
    </Link>
  ) : (
    <div style={cardStyle}>{children}</div>
  );
  // Wrap in a positioned grid item so the overlays can sit on top as siblings.
  return (
    <div style={{ gridColumn, gridRow, position: "relative" }}>
      {card}
      {hidden && <div aria-hidden style={hiddenOutlineStyle(radius)} />}
      {/* Owner-only interactive overlays render ONLY when the session may manage
          this deck. The `hidden`/desaturation styling above still tracks
          `publishSlug` regardless, so a presenter viewing a non-manageable deck
          sees its status but no controls. */}
      {canManage && editHref && <EditPill href={editHref} />}
      {canManage && publishSlug && <PublishControl slug={publishSlug} isAdmin={!!isAdmin} />}
      {canManage && uploaded && <UploadedActions deck={uploaded} />}
    </div>
  );
}

// ---- main -------------------------------------------------------------------

export function DeckLibrary({ decks, isAdmin }: { decks: DeckCard[]; isAdmin: boolean }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [name, setName] = useState<string | null>(null);

  // The one shared upload panel (create or replace). null = closed. See AdminCtx.
  const [panel, setPanel] = useState<PanelState | null>(null);

  // Live publish state, seeded from the server-rendered props and thereafter the
  // single source of truth for every card. The API's response statusMap is the
  // authority on success (it reflects the demote-the-old-main side effect), so we
  // merge it wholesale rather than optimistically flipping just the clicked slug.
  const [statusMap, setStatusMap] = useState<Record<string, PublishStatus>>(() =>
    Object.fromEntries(decks.map((d) => [d.slug, d.publishStatus])),
  );
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  // Which decks may be featured on "/" (Live). "/" has two render paths, so a deck
  // qualifies via EITHER: an embedUrl (the first-party deck's same-origin iframe) or,
  // for an uploaded deck, a contentUrl (rendered through UploadedDeckFrame). A deck
  // with neither can't be shown and is gated out. Derived from the (stable) props;
  // the server enforces the same rule (app/api/admin/publish) as the real boundary.
  const embeddable = useMemo(
    () =>
      new Set(
        decks
          .filter((d) => d.embedUrl || (d.kind === "uploaded" && d.contentUrl))
          .map((d) => d.slug),
      ),
    [decks],
  );

  const setStatus = useCallback((slug: string, status: PublishStatus) => {
    setSaving((s) => ({ ...s, [slug]: true }));
    setErrors((e) => ({ ...e, [slug]: null }));
    void (async () => {
      try {
        const res = await fetch("/api/admin/publish", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, status }),
        });
        if (res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            statusMap?: Record<string, PublishStatus>;
          };
          if (data.statusMap) setStatusMap((prev) => ({ ...prev, ...data.statusMap }));
        } else {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          setErrors((e) => ({ ...e, [slug]: publishErrorMessage(res.status, data.error) }));
        }
      } catch {
        setErrors((e) => ({ ...e, [slug]: "Network error — try again." }));
      } finally {
        setSaving((s) => ({ ...s, [slug]: false }));
      }
    })();
  }, []);

  const publishCtx = useMemo<PublishCtxValue>(
    () => ({
      statusOf: (slug) => statusMap[slug] ?? "normal",
      isSaving: (slug) => !!saving[slug],
      errorOf: (slug) => errors[slug] ?? null,
      embeddableOf: (slug) => embeddable.has(slug),
      setStatus,
    }),
    [statusMap, saving, errors, embeddable, setStatus],
  );

  // Fold any decks the props now carry but statusMap hasn't seen into the live
  // map. statusMap seeds ONCE from props (useState initializer), so after a
  // router.refresh() adds a freshly-uploaded deck, its correct 'unpublished'
  // status would otherwise fall through to the 'normal' default — showing a
  // brand-new upload as already-public. Only ADD unseen slugs; never clobber a
  // slug the presenter is actively editing (its live value is the authority).
  useEffect(() => {
    setStatusMap((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const d of decks) {
        if (!(d.slug in next)) {
          next[d.slug] = d.publishStatus;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [decks]);

  const adminCtx = useMemo<AdminCtxValue>(
    () => ({
      openCreate: () => setPanel({ mode: "create" }),
      openReplace: (deck) => setPanel({ mode: "replace", deck }),
      openImport: () => setPanel({ mode: "import" }),
      refresh: () => router.refresh(),
    }),
    [router],
  );

  useEffect(() => {
    try {
      setName(localStorage.getItem(NAME_KEY));
    } catch {
      /* ignore */
    }
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return decks;
    return decks.filter((d) => `${d.title} ${d.description}`.toLowerCase().includes(needle));
  }, [q, decks]);

  async function logout() {
    try {
      await fetch("/api/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    window.location.href = "/login";
  }

  const totalSlides = useMemo(() => decks.reduce((n, d) => n + d.slideCount, 0), [decks]);
  const resume = decks[0];
  const cardCount = Math.min(decks.length, 5) + Math.max(0, Math.min(5 - decks.length, SAMPLE_DECKS.length));
  const searching = q.trim().length > 0;

  return (
    <PublishCtx.Provider value={publishCtx}>
    <AdminCtx.Provider value={adminCtx}>
    <div
      style={{
        minHeight: "100vh",
        padding: "34px 38px 46px",
        display: "flex",
        justifyContent: "center",
        background: "#ECEAE3",
        backgroundImage: "radial-gradient(rgba(40,38,32,0.045) 1px, transparent 1.4px)",
        backgroundSize: "22px 22px",
      }}
    >
      <div style={{ width: "100%", minWidth: "min(1200px, 100%)", maxWidth: 1460 }}>
        {/* ============ TOP BAR ============ */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24, marginBottom: 30 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 13, userSelect: "none" }}>
            <div
              style={{
                flex: "0 0 auto",
                width: 42,
                height: 42,
                borderRadius: 13,
                background: "rgba(255,255,255,0.55)",
                border: "1px solid rgba(255,255,255,0.75)",
                backdropFilter: "blur(14px)",
                WebkitBackdropFilter: "blur(14px)",
                boxShadow: "0 6px 18px -10px rgba(60,55,45,0.4)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="#3A3A40" strokeWidth={1.1}>
                <circle cx="10" cy="10" r="3.1" />
                <g strokeLinecap="round">
                  <path d="M10 1.4V4M10 16v2.6M1.4 10H4M16 10h2.6M3.9 3.9l1.8 1.8M14.3 14.3l1.8 1.8M16.1 3.9l-1.8 1.8M5.7 14.3l-1.8 1.8" />
                </g>
              </svg>
            </div>
            <div style={{ fontSize: 19, fontWeight: 500, letterSpacing: "0.01em", color: "#262229" }}>Solis</div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {/* Discoverable entry to the "Build a deck with AI" guide (/build) —
                the copy-paste author prompt + pre-upload self-check. A labelled
                frosted pill matching the search box so it reads as first-class
                navigation, not decoration. */}
            <Link
              href="/build"
              className="lm-build"
              title="Get the AI prompt and a pre-upload checklist"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                height: 44,
                padding: "0 15px",
                borderRadius: 14,
                textDecoration: "none",
                color: "#4A4750",
                fontSize: 13.5,
                fontWeight: 400,
                whiteSpace: "nowrap",
                background: "rgba(255,255,255,0.5)",
                border: "1px solid rgba(255,255,255,0.7)",
                backdropFilter: "blur(14px)",
                WebkitBackdropFilter: "blur(14px)",
                boxShadow: "0 6px 18px -12px rgba(60,55,45,0.35)",
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#8A857C" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 1.5l1.4 3.6L13 6.5l-3.6 1.4L8 11.5 6.6 7.9 3 6.5l3.6-1.4z" />
                <path d="M12.5 10.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
              </svg>
              Build with AI
            </Link>
            {/* Sibling entry to the in-browser AI Studio (/studio) — generate a deck
                live with your own OpenRouter key. Same frosted pill as "Build with
                AI" so the two author paths read as one row of navigation. */}
            <Link
              href="/studio"
              className="lm-build"
              title="Generate a deck in the browser with your own AI key"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                height: 44,
                padding: "0 15px",
                borderRadius: 14,
                textDecoration: "none",
                color: "#4A4750",
                fontSize: 13.5,
                fontWeight: 400,
                whiteSpace: "nowrap",
                background: "rgba(255,255,255,0.5)",
                border: "1px solid rgba(255,255,255,0.7)",
                backdropFilter: "blur(14px)",
                WebkitBackdropFilter: "blur(14px)",
                boxShadow: "0 6px 18px -12px rgba(60,55,45,0.35)",
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#8A857C" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="12" height="8.5" rx="1.6" />
                <path d="M5.5 13.5h5" />
                <path d="M6 6l2 1.75L6 9.5" />
              </svg>
              Studio
            </Link>
            {/* Sibling author entry — opens the shared panel in import mode
                (Markdown → deck). A <button> (not a <Link>) because it opens a
                modal, styled with the same frosted `.lm-build` pill so the three
                author paths read as one row of navigation. */}
            <button
              type="button"
              className="lm-build"
              onClick={() => adminCtx.openImport()}
              title="Create a deck by pasting Markdown"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                height: 44,
                padding: "0 15px",
                borderRadius: 14,
                textDecoration: "none",
                color: "#4A4750",
                fontFamily: "inherit",
                fontSize: 13.5,
                fontWeight: 400,
                whiteSpace: "nowrap",
                cursor: "pointer",
                background: "rgba(255,255,255,0.5)",
                border: "1px solid rgba(255,255,255,0.7)",
                backdropFilter: "blur(14px)",
                WebkitBackdropFilter: "blur(14px)",
                boxShadow: "0 6px 18px -12px rgba(60,55,45,0.35)",
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#8A857C" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round">
                <rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1.8" />
                <path d="M4.4 10.6V6l1.9 2.1L8.2 6v4.6" />
                <path d="M10.4 6v3.4M9.1 8.1l1.3 1.4 1.3-1.4" />
              </svg>
              Import Markdown
            </button>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: 300,
                height: 44,
                padding: "0 16px",
                borderRadius: 14,
                background: "rgba(255,255,255,0.5)",
                border: "1px solid rgba(255,255,255,0.7)",
                backdropFilter: "blur(14px)",
                WebkitBackdropFilter: "blur(14px)",
                boxShadow: "0 6px 18px -12px rgba(60,55,45,0.35)",
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#8A8A92" strokeWidth={1.3} style={{ flex: "0 0 auto" }}>
                <circle cx="7" cy="7" r="5" />
                <path d="M11 11l3.5 3.5" strokeLinecap="round" />
              </svg>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search decks…"
                aria-label="Search decks"
                style={{
                  border: "none",
                  outline: "none",
                  background: "transparent",
                  width: "100%",
                  fontFamily: "inherit",
                  fontSize: 14.5,
                  fontWeight: 300,
                  color: "#4A4750",
                }}
              />
            </div>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 14,
                background: "rgba(255,255,255,0.6)",
                border: "1px solid rgba(255,255,255,0.8)",
                backdropFilter: "blur(14px)",
                WebkitBackdropFilter: "blur(14px)",
                boxShadow: "0 6px 18px -12px rgba(60,55,45,0.35)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 9,
                  background: "radial-gradient(120% 120% at 30% 20%, #CBE94A 0%, #9DBE93 60%, #8FA6C6 100%)",
                }}
              />
            </div>
          </div>
        </div>

        {/* ============ MAIN ============ */}
        <div style={{ display: "flex", gap: 18 }}>
          {/* nav rail */}
          <div style={{ flex: "0 0 60px", display: "flex", flexDirection: "column", alignItems: "center", gap: 12, paddingTop: 4 }}>
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: 16,
                background: "rgba(255,255,255,0.62)",
                border: "1px solid rgba(255,255,255,0.85)",
                backdropFilter: "blur(16px)",
                WebkitBackdropFilter: "blur(16px)",
                boxShadow: "0 8px 22px -12px rgba(60,55,45,0.4)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                position: "relative",
              }}
            >
              <span style={{ position: "absolute", left: -9, top: "50%", transform: "translateY(-50%)", width: 3, height: 22, borderRadius: 2, background: "#BFE048" }} />
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="#2C2C32" strokeWidth={1.3}>
                <rect x="3" y="3" width="6" height="6" rx="1.6" />
                <rect x="11" y="3" width="6" height="6" rx="1.6" />
                <rect x="3" y="11" width="6" height="6" rx="1.6" />
                <rect x="11" y="11" width="6" height="6" rx="1.6" />
              </svg>
            </div>
            {/* Admin-only entry to the invitations manager. Styled identically to
                the logout button so the rail reads as one control column. */}
            {isAdmin && (
              <Link
                href="/dashboard/invites"
                title="Invitations"
                aria-label="Invitations"
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 16,
                  background: "rgba(255,255,255,0.4)",
                  border: "1px solid rgba(255,255,255,0.6)",
                  backdropFilter: "blur(10px)",
                  WebkitBackdropFilter: "blur(10px)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#7B7B83" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <path d="M3 7l9 6 9-6" />
                </svg>
              </Link>
            )}
            <button
              type="button"
              onClick={logout}
              title="Sign out"
              aria-label="Sign out"
              style={{
                width: 52,
                height: 52,
                borderRadius: 16,
                padding: 0,
                background: "rgba(255,255,255,0.4)",
                border: "1px solid rgba(255,255,255,0.6)",
                backdropFilter: "blur(10px)",
                WebkitBackdropFilter: "blur(10px)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
              }}
            >
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#7B7B83" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <path d="M16 17l5-5-5-5" />
                <path d="M21 12H9" />
              </svg>
            </button>
          </div>

          {/* content column */}
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 18 }}>
            {searching ? (
              <SearchResults results={filtered} query={q} isAdmin={isAdmin} />
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0,0.92fr) minmax(0,1.5fr)", gap: 22, alignItems: "stretch" }}>
                <Hero name={name} deckWord={numberWord(cardCount)} totalSlides={totalSlides} resume={resume} />
                <Bento decks={decks} isAdmin={isAdmin} />
              </div>
            )}
          </div>
        </div>
      </div>

      <style>{`
        .lm-card:hover { transform: translateY(-3px); box-shadow: 0 22px 46px -22px rgba(60,55,45,0.55) !important; }
        .lm-build:hover { background: rgba(255,255,255,0.66) !important; }
        .lm-new:hover { background: rgba(255,255,255,0.6) !important; }
        .lm-edit:hover { background: rgba(30,28,26,0.52) !important; border-color: rgba(255,255,255,0.55) !important; }
        .lm-pub-seg-o:hover { background: rgba(255,255,255,0.16) !important; }
        .lm-pub-seg-i:hover { background: rgba(40,38,32,0.07) !important; }
        .lm-act:hover { background: rgba(30,28,26,0.52) !important; border-color: rgba(255,255,255,0.55) !important; }
        .lm-act-danger:hover { background: rgba(150,40,30,0.62) !important; }
        .lm-panel-btn:hover { filter: brightness(1.06); }
      `}</style>
      {panel && panel.mode === "import" && (
        <ImportPanel
          onClose={() => setPanel(null)}
          onDone={() => {
            setPanel(null);
            adminCtx.refresh();
          }}
        />
      )}
      {panel && panel.mode !== "import" && (
        <UploadPanel
          panel={panel}
          onClose={() => setPanel(null)}
          onDone={() => {
            setPanel(null);
            adminCtx.refresh();
          }}
        />
      )}
    </div>
    </AdminCtx.Provider>
    </PublishCtx.Provider>
  );
}

// ---- hero -------------------------------------------------------------------

function Hero({
  name,
  deckWord,
  totalSlides,
  resume,
}: {
  name: string | null;
  deckWord: string;
  totalSlides: number;
  resume?: DeckCard;
}) {
  return (
    <div style={{ position: "relative", display: "flex", flexDirection: "column", justifyContent: "space-between", minHeight: 520, padding: "6px 8px" }}>
      <div>
        <div style={{ fontSize: 12, fontWeight: 500, letterSpacing: "0.22em", textTransform: "uppercase", color: "#9A958A", marginBottom: 18 }}>
          Library
        </div>
        <h1 style={{ fontSize: 44, fontWeight: 300, lineHeight: 1.06, letterSpacing: "-0.025em", margin: 0, color: "#262229" }}>
          {name ? (
            <>
              Good to see you,
              <br />
              {name}.
            </>
          ) : (
            <>
              Good to see you
              <br />
              again.
            </>
          )}
        </h1>
        <p style={{ fontSize: 16, fontWeight: 300, lineHeight: 1.5, color: "#6E6A62", margin: "18px 0 0", maxWidth: "32ch" }}>
          {deckWord} decks ready to present — pick up where you left off, or open the floor to a new room.
        </p>
      </div>

      {/* orbital motif + annotated stats */}
      <div style={{ position: "relative", flex: 1, display: "flex", alignItems: "center", justifyContent: "center", margin: "6px 0" }}>
        <svg width="290" height="290" viewBox="0 0 300 300" fill="none" stroke="rgba(42,40,46,0.22)" strokeWidth={1} style={{ overflow: "visible" }}>
          <circle cx="150" cy="150" r="128" />
          <ellipse cx="150" cy="150" rx="118" ry="128" />
          <ellipse cx="150" cy="150" rx="96" ry="128" />
          <ellipse cx="150" cy="150" rx="68" ry="128" />
          <ellipse cx="150" cy="150" rx="36" ry="128" />
          <ellipse cx="150" cy="150" rx="128" ry="118" stroke="rgba(42,40,46,0.13)" />
          <ellipse cx="150" cy="150" rx="128" ry="74" stroke="rgba(42,40,46,0.13)" />
          <ellipse cx="150" cy="150" rx="128" ry="32" stroke="rgba(42,40,46,0.13)" />
          <line x1="150" y1="22" x2="150" y2="278" stroke="rgba(42,40,46,0.10)" />
        </svg>

        {/* focal dot 1 — questions answered */}
        <div style={{ position: "absolute", left: "62%", top: "30%" }}>
          <div style={{ width: 11, height: 11, borderRadius: "50%", background: "#CBE94A", boxShadow: "0 0 0 5px rgba(203,233,74,0.22)" }} />
          <svg width="74" height="34" viewBox="0 0 74 34" style={{ position: "absolute", left: 6, top: -2 }} fill="none" stroke="rgba(42,40,46,0.3)" strokeWidth={1}>
            <path d="M2 30 L40 30 L70 4" />
          </svg>
          <div style={{ position: "absolute", left: 72, top: -26, whiteSpace: "nowrap" }}>
            <div style={{ fontSize: 21, fontWeight: 300, lineHeight: 1, color: "#2A2730" }}>240</div>
            <div style={{ fontSize: 11, fontWeight: 400, color: "#8A857C", marginTop: 2 }}>questions answered</div>
          </div>
        </div>

        {/* focal dot 2 — slides in library */}
        <div style={{ position: "absolute", left: "30%", top: "66%" }}>
          <div style={{ width: 9, height: 9, borderRadius: "50%", background: "#FFFFFF", boxShadow: "0 0 0 4px rgba(255,255,255,0.5),0 1px 4px rgba(0,0,0,0.12)" }} />
          <svg width="58" height="30" viewBox="0 0 58 30" style={{ position: "absolute", left: -54, top: 4 }} fill="none" stroke="rgba(42,40,46,0.3)" strokeWidth={1}>
            <path d="M56 4 L20 4 L2 26" />
          </svg>
          <div style={{ position: "absolute", left: -150, top: 18, whiteSpace: "nowrap", textAlign: "right", width: 96 }}>
            <div style={{ fontSize: 21, fontWeight: 300, lineHeight: 1, color: "#2A2730" }}>{totalSlides}</div>
            <div style={{ fontSize: 11, fontWeight: 400, color: "#8A857C", marginTop: 2 }}>slides in library</div>
          </div>
        </div>
      </div>

      {/* resume strip */}
      <ResumeStrip resume={resume} />
    </div>
  );
}

function ResumeStrip({ resume }: { resume?: DeckCard }) {
  const inner = (
    <>
      <div
        style={{
          width: 50,
          height: 50,
          borderRadius: 12,
          flex: "0 0 auto",
          background:
            "radial-gradient(100% 110% at 25% 20%, #D8C57E 0%, transparent 55%),radial-gradient(110% 120% at 85% 85%, #A8B87E 0%, transparent 55%),linear-gradient(150deg,#C7B873,#B6B57E)",
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 10.5, fontWeight: 500, letterSpacing: "0.16em", textTransform: "uppercase", color: "#A29D92" }}>Resume</div>
        <div style={{ fontSize: 14.5, fontWeight: 400, color: "#2C2932", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {resume ? resume.title : "Nothing yet"}
        </div>
        <div style={{ fontSize: 12, fontWeight: 300, color: "#8A857C" }}>
          {resume ? `${resume.slideCount} ${resume.slideCount === 1 ? "slide" : "slides"}` : "add a deck to begin"}
        </div>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          height: 40,
          padding: "0 18px",
          borderRadius: 12,
          background: "#2C2A31",
          color: "#F4F2EC",
          fontSize: 13.5,
          fontWeight: 400,
        }}
      >
        Resume <span style={{ fontSize: 11 }}>▸</span>
      </div>
    </>
  );

  const shell: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 16,
    padding: "14px 16px",
    borderRadius: 18,
    background: "rgba(255,255,255,0.5)",
    border: "1px solid rgba(255,255,255,0.72)",
    backdropFilter: "blur(16px)",
    WebkitBackdropFilter: "blur(16px)",
    boxShadow: "0 10px 28px -16px rgba(60,55,45,0.4)",
    textDecoration: "none",
    color: "inherit",
  };

  return resume ? (
    <Link href={`/d/${resume.slug}`} style={shell}>
      {inner}
    </Link>
  ) : (
    <div style={shell}>{inner}</div>
  );
}

// ---- bento ------------------------------------------------------------------

function Bento({ decks, isAdmin }: { decks: DeckCard[]; isAdmin: boolean }) {
  // Fill the five deck slots newest-first with real decks, then sample decks so
  // the grid always reads as full. items[0]=featured, [1]=wide, [2]=tall,
  // [3]=small, [4]=wide.
  const real = decks.slice(0, 5);
  const fillers = SAMPLE_DECKS.slice(0, Math.max(0, 5 - real.length));
  const items: Item[] = [...real, ...fillers.map((f) => ({ ...f, sample: true as const }))];
  const [c0, c1, c2, c3, c4] = items;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4,minmax(0,1fr))", gridTemplateRows: "repeat(3,158px)", gap: 14 }}>
      {c0 && <FeaturedCard item={c0} isAdmin={isAdmin} />}
      {c1 && <WideGreenCard item={c1} isAdmin={isAdmin} />}
      {c2 && <TallGoldCard item={c2} isAdmin={isAdmin} />}
      {c3 && <SmallCoralCard item={c3} isAdmin={isAdmin} />}
      {c4 && <WideLimeCard item={c4} isAdmin={isAdmin} />}
      <NewDeckCard />
    </div>
  );
}

type Item = DeckCard | (SampleDeck & { sample: true });
function isSample(i: Item): i is SampleDeck & { sample: true } {
  return (i as { sample?: boolean }).sample === true;
}
function hrefOf(i: Item): string | undefined {
  return !isSample(i) && (i as DeckCard).slug ? `/d/${(i as DeckCard).slug}` : undefined;
}
// The presenter-only editor link for a real deck (undefined for sample cards).
function editHrefOf(i: Item): string | undefined {
  return !isSample(i) && (i as DeckCard).slug ? `/dashboard/edit/${(i as DeckCard).slug}` : undefined;
}
// The slug a publish control acts on — undefined for decorative sample cards.
function slugOf(i: Item): string | undefined {
  return !isSample(i) ? (i as DeckCard).slug : undefined;
}
// The DeckCard when this item is an UPLOADED (DB-backed) deck — the only kind
// that gets Replace/Delete/Preview. Undefined for sample and registry cards.
function uploadedOf(i: Item): DeckCard | undefined {
  if (isSample(i)) return undefined;
  const d = i as DeckCard;
  return d.kind === "uploaded" ? d : undefined;
}
// Phase 4 — may the current session manage this item? Only real decks flagged
// canManage qualify; sample/decorative cards are never manageable.
function canManageOf(i: Item): boolean {
  return !isSample(i) && (i as DeckCard).canManage === true;
}
function shortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
// Contextual tag shown top-left of a card (matches the design's "Week 1",
// "Lecture 7", "Seminar" tags): sample decks carry their own; real decks show
// their date.
function metaOf(i: Item): string {
  if (isSample(i)) return i.meta;
  return shortDate((i as DeckCard).date) || "Deck";
}

function CardTopRow({ label, arrowSize = 16 }: { label: string; arrowSize?: number }) {
  return (
    <div style={{ position: "relative", display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
      <div style={{ fontSize: 13, fontWeight: 400, color: "rgba(255,255,255,0.9)" }}>{label}</div>
      <ArrowGlyph size={arrowSize} />
    </div>
  );
}

function FeaturedCard({ item, isAdmin }: { item: Item; isAdmin: boolean }) {
  return (
    <BentoCard
      href={hrefOf(item)}
      editHref={editHrefOf(item)}
      publishSlug={slugOf(item)}
      uploaded={uploadedOf(item)}
      canManage={canManageOf(item)}
      isAdmin={isAdmin}
      gridColumn="span 2"
      gridRow="span 2"
      radius={24}
      background="radial-gradient(90% 120% at 12% 16%, #ECC98A 0%, rgba(236,201,138,0) 55%),radial-gradient(100% 120% at 90% 24%, #E89B72 0%, rgba(232,155,114,0) 55%),radial-gradient(130% 130% at 70% 112%, #E7C26A 0%, rgba(231,194,106,0) 60%),linear-gradient(150deg,#E0A878,#E6B96E)"
      boxShadow="0 16px 38px -20px rgba(150,100,60,0.5)"
    >
      <CardNoise />
      <div style={{ position: "relative", padding: "24px 26px 0" }}>
        <CardTopRow label={isSample(item) ? item.meta : "Most recent"} />
      </div>
      <WaveformMotif />
      <div style={{ position: "relative", padding: "0 26px 24px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <div style={{ fontSize: 66, fontWeight: 200, lineHeight: 0.9, letterSpacing: "-0.03em", color: "#FFFFFF" }}>{item.slideCount}</div>
          <div style={{ fontSize: 15, fontWeight: 300, color: "rgba(255,255,255,0.85)" }}>slides</div>
        </div>
        <div style={{ fontSize: 24, fontWeight: 400, lineHeight: 1.12, letterSpacing: "-0.01em", color: "#FFFFFF", marginTop: 8, maxWidth: "16ch" }}>
          {item.title}
        </div>
      </div>
    </BentoCard>
  );
}

function WideGreenCard({ item, isAdmin }: { item: Item; isAdmin: boolean }) {
  return (
    <BentoCard
      href={hrefOf(item)}
      editHref={editHrefOf(item)}
      publishSlug={slugOf(item)}
      uploaded={uploadedOf(item)}
      canManage={canManageOf(item)}
      isAdmin={isAdmin}
      gridColumn="span 2"
      gridRow="span 1"
      background="radial-gradient(90% 130% at 18% 20%, #B7CE9E 0%, transparent 55%),radial-gradient(110% 130% at 88% 85%, #9DBE93 0%, transparent 55%),radial-gradient(120% 120% at 60% 0%, #C9D5A3 0%, transparent 50%),linear-gradient(160deg,#A8C291,#93B488)"
      boxShadow="0 14px 32px -20px rgba(90,120,80,0.5)"
    >
      <div style={{ position: "relative", padding: "20px 22px 0" }}>
        <CardTopRow label={metaOf(item)} arrowSize={15} />
      </div>
      <SphereMotifRight />
      <div style={{ position: "relative", padding: "0 22px 20px", fontSize: 18, fontWeight: 400, letterSpacing: "-0.01em", color: "#FFFFFF", maxWidth: "18ch" }}>
        {item.title}
      </div>
    </BentoCard>
  );
}

function TallGoldCard({ item, isAdmin }: { item: Item; isAdmin: boolean }) {
  return (
    <BentoCard
      href={hrefOf(item)}
      editHref={editHrefOf(item)}
      publishSlug={slugOf(item)}
      uploaded={uploadedOf(item)}
      canManage={canManageOf(item)}
      isAdmin={isAdmin}
      gridColumn="span 1"
      gridRow="span 2"
      background="radial-gradient(100% 110% at 22% 14%, #D8C57E 0%, transparent 55%),radial-gradient(120% 120% at 82% 88%, #A8B87E 0%, transparent 55%),linear-gradient(160deg,#C9B873,#B4B47C)"
      boxShadow="0 14px 32px -20px rgba(130,120,70,0.5)"
    >
      <div style={{ position: "relative", padding: "20px 20px 0" }}>
        <CardTopRow label={metaOf(item)} arrowSize={15} />
      </div>
      <VortexMotif />
      <div style={{ position: "relative", padding: "0 20px 20px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <div style={{ fontSize: 42, fontWeight: 200, lineHeight: 0.9, letterSpacing: "-0.03em", color: "#FFFFFF" }}>{item.slideCount}</div>
          <div style={{ fontSize: 13, fontWeight: 300, color: "rgba(255,255,255,0.8)" }}>slides</div>
        </div>
        <div style={{ fontSize: 16, fontWeight: 400, lineHeight: 1.15, color: "#FFFFFF", marginTop: 6, maxWidth: "12ch" }}>{item.title}</div>
      </div>
    </BentoCard>
  );
}

function SmallCoralCard({ item, isAdmin }: { item: Item; isAdmin: boolean }) {
  return (
    <BentoCard
      href={hrefOf(item)}
      editHref={editHrefOf(item)}
      publishSlug={slugOf(item)}
      uploaded={uploadedOf(item)}
      canManage={canManageOf(item)}
      isAdmin={isAdmin}
      gridColumn="span 1"
      gridRow="span 1"
      background="radial-gradient(100% 120% at 18% 12%, #E9A07C 0%, transparent 55%),radial-gradient(120% 120% at 92% 96%, #93A8C6 0%, transparent 60%),linear-gradient(150deg,#E0A487,#A6A9C0)"
      boxShadow="0 14px 32px -20px rgba(150,110,110,0.5)"
    >
      <div style={{ position: "relative", padding: "18px 18px 0" }}>
        <CardTopRow label={metaOf(item)} arrowSize={14} />
      </div>
      <ArcMotif />
      <div style={{ position: "relative", padding: "0 18px 18px", fontSize: 13.5, fontWeight: 400, lineHeight: 1.2, color: "#FFFFFF" }}>{item.title}</div>
    </BentoCard>
  );
}

function WideLimeCard({ item, isAdmin }: { item: Item; isAdmin: boolean }) {
  return (
    <BentoCard
      href={hrefOf(item)}
      editHref={editHrefOf(item)}
      publishSlug={slugOf(item)}
      uploaded={uploadedOf(item)}
      canManage={canManageOf(item)}
      isAdmin={isAdmin}
      gridColumn="span 2"
      gridRow="span 1"
      background="radial-gradient(90% 130% at 16% 18%, #C6D88A 0%, transparent 55%),radial-gradient(120% 130% at 86% 84%, #9BC07E 0%, transparent 55%),linear-gradient(150deg,#AEC97F,#BBD06E)"
      boxShadow="0 14px 32px -20px rgba(110,140,70,0.5)"
    >
      <div style={{ position: "relative", padding: "20px 22px", display: "flex", alignItems: "center", justifyContent: "space-between", flex: 1 }}>
        <div style={{ position: "relative" }}>
          <div style={{ fontSize: 12.5, fontWeight: 400, color: "rgba(255,255,255,0.9)", marginBottom: 10 }}>{metaOf(item)}</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
            <div style={{ fontSize: 36, fontWeight: 200, lineHeight: 0.9, letterSpacing: "-0.02em", color: "#FFFFFF" }}>
              {String(item.slideCount).padStart(2, "0")}
            </div>
            <div style={{ fontSize: 18, fontWeight: 400, color: "#FFFFFF" }}>{item.title}</div>
          </div>
        </div>
        <SphereMotifInline />
      </div>
    </BentoCard>
  );
}

// The "New deck" tile — no longer decorative. Clicking it opens the shared
// upload panel (create mode) which POSTs an HTML deck to /api/admin/decks. A
// <button> (not a div) so it's keyboard-reachable like the affordance it now is.
function NewDeckCard() {
  const admin = useAdmin();
  return (
    <button
      type="button"
      className="lm-new"
      onClick={() => admin?.openCreate()}
      title="Upload a self-contained HTML deck"
      style={{
        gridColumn: "span 1",
        gridRow: "span 1",
        borderRadius: 22,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        background: "rgba(255,255,255,0.42)",
        border: "1px solid rgba(255,255,255,0.7)",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        boxShadow: "0 12px 30px -18px rgba(60,55,45,0.4)",
        transition: "background .18s cubic-bezier(.2,.6,.2,1)",
        cursor: "pointer",
        fontFamily: "inherit",
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: 13,
          background: "rgba(255,255,255,0.6)",
          border: "1px solid rgba(255,255,255,0.85)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="#3A3A40" strokeWidth={1.3} strokeLinecap="round">
          <path d="M9 4v10M4 9h10" />
        </svg>
      </div>
      <div style={{ fontSize: 13.5, fontWeight: 400, color: "#4A4750" }}>New deck</div>
    </button>
  );
}

// ---- uploaded-deck actions (Replace / Preview / Delete) ---------------------

// A small frosted button matching EditPill's language — the shared chrome for
// every uploaded-deck action so the row reads as one control cluster.
function actionPillStyle(danger: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    height: 26,
    padding: "0 9px",
    borderRadius: 9,
    border: danger ? "1px solid rgba(255,180,170,0.5)" : "1px solid rgba(255,255,255,0.35)",
    background: danger ? "rgba(150,40,30,0.42)" : "rgba(30,28,26,0.34)",
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
    color: "rgba(255,255,255,0.95)",
    fontFamily: "inherit",
    fontSize: 11.5,
    fontWeight: 500,
    whiteSpace: "nowrap",
    cursor: "pointer",
  };
}

// Replace / Preview / Delete for one uploaded deck. Like EditPill/PublishControl
// it's a SIBLING of the card's <Link> (never nested — nested anchors are invalid
// HTML), so its clicks POST/GET/DELETE without also firing the card's navigation
// (stopPropagation). Overlay mode anchors bottom-left of a bento card; inline
// mode sits under a search-result card. Delete is two-step (a confirm) so a
// stray click can't destroy a deck. Replace defers to the shared upload panel.
function UploadedActions({ deck, variant = "overlay" }: { deck: DeckCard; variant?: "overlay" | "inline" }) {
  const admin = useAdmin();
  const [busy, setBusy] = useState<null | "preview" | "delete" | "duplicate">(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const overlay = variant === "overlay";

  async function duplicate() {
    setError(null);
    setBusy("duplicate");
    try {
      const res = await fetch(`/api/admin/decks/${deck.slug}/duplicate`, { method: "POST" });
      if (res.ok) {
        // The fork exists as a new row; re-run the server component so its card
        // appears in the grid (this control unmounts / re-renders on refresh).
        admin?.refresh();
        return; // leave `busy` set — the grid repaints on refresh
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(adminErrorMessage(res.status, data.error));
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(null);
    }
  }

  // A plain GET file download: navigate to the owner-gated download route, which
  // returns the fully self-contained deck as an attachment. No fetch()-and-blob
  // (unnecessary) and no saving state (it's a navigation, not an in-app mutation).
  function download() {
    window.location.href = `/api/admin/decks/${deck.slug}/download`;
  }

  async function preview() {
    setError(null);
    setBusy("preview");
    // Open the tab synchronously so the browser credits it to this click (a
    // post-await window.open is treated as an unrequested popup and blocked). It
    // starts blank, then we point it at the minted URL once the token returns —
    // or close it on failure. opener is nulled while it's still same-origin
    // about:blank so the isolated deck origin gets no handle back to the app.
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      const res = await fetch(`/api/admin/decks/${deck.slug}/preview`);
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (res.ok && data.url) {
        if (tab) tab.location.href = data.url;
      } else {
        if (tab) tab.close();
        setError(adminErrorMessage(res.status, data.error));
      }
    } catch {
      if (tab) tab.close();
      setError("Network error — try again.");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setError(null);
    setBusy("delete");
    try {
      const res = await fetch(`/api/admin/decks/${deck.slug}`, { method: "DELETE" });
      if (res.ok) {
        // The row is gone; re-run the server component so the card disappears.
        admin?.refresh();
        return; // leave `busy` set — this control unmounts on refresh
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(adminErrorMessage(res.status, data.error));
      setConfirming(false);
    } catch {
      setError("Network error — try again.");
      setConfirming(false);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={
        overlay
          ? { position: "absolute", bottom: 10, left: 10, zIndex: 3, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6 }
          : { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6, marginTop: 12 }
      }
    >
      <div style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {confirming ? (
          <>
            <button
              type="button"
              className="lm-act-danger"
              onClick={remove}
              disabled={busy === "delete"}
              style={actionPillStyle(true)}
            >
              {busy === "delete" ? "Deleting…" : "Confirm delete"}
            </button>
            <button
              type="button"
              className="lm-act"
              onClick={() => setConfirming(false)}
              disabled={busy === "delete"}
              style={actionPillStyle(false)}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button type="button" className="lm-act" onClick={() => admin?.openReplace(deck)} title="Replace this deck's HTML" style={actionPillStyle(false)}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 7a5 5 0 1 0-1.3 4M13 3v4h-4" />
              </svg>
              Replace
            </button>
            <button type="button" className="lm-act" onClick={preview} disabled={busy === "preview"} title="Open a signed preview in a new tab" style={actionPillStyle(false)}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
                <path d="M1.5 8S4 3 8 3s6.5 5 6.5 5-2.5 5-6.5 5-6.5-5-6.5-5z" />
                <circle cx="8" cy="8" r="1.8" />
              </svg>
              {busy === "preview" ? "Opening…" : "Preview"}
            </button>
            <button type="button" className="lm-act" onClick={duplicate} disabled={busy === "duplicate"} title="Duplicate this deck (a private copy you own)" style={actionPillStyle(false)}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
                <rect x="5.5" y="5.5" width="8" height="8" rx="1.4" />
                <path d="M10.5 5.5V4a1.4 1.4 0 0 0-1.4-1.4H4A1.4 1.4 0 0 0 2.6 4v5.1A1.4 1.4 0 0 0 4 10.5h1.5" />
              </svg>
              {busy === "duplicate" ? "Duplicating…" : "Duplicate"}
            </button>
            <button type="button" className="lm-act" onClick={download} title="Download a self-contained, offline copy" style={actionPillStyle(false)}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 2.5v7M5 6.5 8 9.5l3-3M3 12.5h10" />
              </svg>
              Download
            </button>
            <button type="button" className="lm-act-danger" onClick={() => setConfirming(true)} title="Delete this deck" style={actionPillStyle(true)}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 4h10M6 4V2.6h4V4M4.5 4l.6 9h5.8l.6-9" />
              </svg>
              Delete
            </button>
          </>
        )}
      </div>
      {error && <span style={statusLineStyle(overlay, true)}>{error}</span>}
    </div>
  );
}

// ---- upload / replace panel -------------------------------------------------

// The shared modal for both creating and replacing an uploaded deck. Reuses the
// same idle/saving/error state machine idiom as PublishControl.setStatus — one
// in-flight guard, an error line on failure, and a parent-driven close on
// success (onDone → refresh). A textarea for pasting HTML is the MVP input; the
// file picker is a convenience that just reads a chosen .html file INTO the same
// textarea (so the submit path is identical whether pasted or picked).
function UploadPanel({ panel, onClose, onDone }: { panel: PanelState; onClose: () => void; onDone: () => void }) {
  const replacing = panel.mode === "replace";
  const existing = replacing ? panel.deck : undefined;
  const [title, setTitle] = useState(existing?.title ?? "");
  const [slug, setSlug] = useState("");
  const [date, setDate] = useState("");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [html, setHtml] = useState("");
  // idle → saving → done. "done" holds the panel open on a result view AFTER a
  // successful store so the boot check can run and warnings can show; the panel
  // no longer auto-closes on success (see submit / dismiss).
  const [status, setStatus] = useState<"idle" | "saving" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  // The validator's 422 invalid_deck issues — the "here's exactly what to fix"
  // list, the primary Phase-2 feedback loop. Kept apart from `error` (a one-line
  // generic failure) so each renders with the right shape.
  const [issues, setIssues] = useState<string[]>([]);
  // Non-blocking warnings returned alongside a SUCCESSFUL store (201/200).
  const [warnings, setWarnings] = useState<string[]>([]);
  // The slug the store actually landed on — POST auto-derives it from the title,
  // so we read it back from the response to point the boot check at the right deck.
  const [resultSlug, setResultSlug] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // One close path for every dismissal (backdrop, Esc, ✕, Cancel/Done). Never
  // mid-save. Once the deck is stored ("done"), a close MUST refresh the grid so
  // the new/updated card appears — route through onDone; before that a plain
  // onClose (nothing changed server-side yet, so no refresh needed).
  const dismiss = useCallback(() => {
    if (status === "saving") return;
    if (status === "done") onDone();
    else onClose();
  }, [status, onClose, onDone]);

  // Esc closes, matching the backdrop click — but never mid-save (a close would
  // strand an in-flight request the presenter can't see the result of).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") dismiss();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismiss]);

  function pickFile(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setHtml(typeof reader.result === "string" ? reader.result : "");
      // Seed the title from the filename only when the presenter hasn't typed one.
      setTitle((t) => t || file.name.replace(/\.html?$/i, ""));
    };
    reader.readAsText(file);
  }

  async function submit() {
    setError(null);
    setIssues([]);
    if (!title.trim() || !html.trim()) {
      setError("Title and HTML are both required.");
      return;
    }
    setStatus("saving");
    try {
      const res = replacing
        ? await fetch(`/api/admin/decks/${existing!.slug}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: title.trim(), html }),
          })
        : await fetch("/api/admin/decks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: title.trim(),
              html,
              // Only send optional fields when set — an empty slug must trigger
              // the server's title-derived auto-slug, not fail slug validation.
              ...(slug.trim() ? { slug: slug.trim() } : {}),
              ...(date.trim() ? { date: date.trim() } : {}),
              ...(description.trim() ? { description: description.trim() } : {}),
            }),
          });
      // POST(201) and PUT(200) both return { slug, warnings }; both reject non-
      // conformance with 422 { error:"invalid_deck", issues, warnings }. Parse
      // once and branch on ok so the create/replace paths share this handler.
      const data = (await res.json().catch(() => ({}))) as {
        slug?: string;
        warnings?: string[];
        issues?: string[];
        error?: string;
      };
      if (res.ok) {
        // Stored. DON'T close yet — switch to the result view so the boot check
        // can run and any warnings show; the presenter dismisses it (→ refresh).
        setResultSlug(data.slug ?? (replacing ? existing!.slug : null));
        setWarnings(Array.isArray(data.warnings) ? data.warnings : []);
        setStatus("done");
        return;
      }
      // 422 invalid_deck is the Phase-2 contract's primary feedback: surface the
      // structural issues verbatim (leading over the generic line) so the
      // presenter knows exactly what to fix, then drop back to idle to retry.
      if (res.status === 422 && Array.isArray(data.issues) && data.issues.length > 0) {
        setIssues(data.issues);
      } else {
        setError(adminErrorMessage(res.status, data.error));
      }
      setStatus("idle");
    } catch {
      setError("Network error — try again.");
      setStatus("idle");
    }
  }

  const saving = status === "saving";
  const done = status === "done";
  const label: React.CSSProperties = { fontSize: 11, fontWeight: 500, letterSpacing: "0.1em", textTransform: "uppercase", color: "#9A958A" };
  const field: React.CSSProperties = {
    width: "100%",
    height: 40,
    padding: "0 12px",
    borderRadius: 11,
    border: "1px solid rgba(60,55,45,0.16)",
    background: "rgba(255,255,255,0.7)",
    fontFamily: "inherit",
    fontSize: 14,
    color: "#2C2932",
    outline: "none",
    boxSizing: "border-box",
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={replacing ? "Replace deck" : "Upload a new deck"}
      onClick={dismiss}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "rgba(30,28,24,0.34)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(640px, 100%)",
          maxHeight: "calc(100vh - 48px)",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 16,
          padding: 26,
          borderRadius: 22,
          background: "#F4F2EC",
          border: "1px solid rgba(255,255,255,0.8)",
          boxShadow: "0 30px 70px -30px rgba(40,35,25,0.6)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 20, fontWeight: 500, letterSpacing: "-0.01em", color: "#262229" }}>
            {done ? (replacing ? "Deck replaced" : "Deck uploaded") : replacing ? "Replace deck content" : "Upload a deck"}
          </div>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Close"
            style={{ width: 32, height: 32, borderRadius: 10, border: "1px solid rgba(60,55,45,0.14)", background: "rgba(255,255,255,0.6)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#6E6A62" strokeWidth={1.5} strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        {done ? (
          // RESULT VIEW — the deck is already stored; confirm it, surface any
          // non-blocking warnings, and run the live boot check. The presenter
          // dismisses via Done / ✕ / Esc / backdrop (all → dismiss → refresh).
          <>
            <div style={noticeStyle("ok")}>
              {replacing
                ? "Content replaced — the deck's link and publish status are unchanged."
                : "Saved as a hidden deck — set it Public or Live from its card when you're ready."}
            </div>
            {warnings.length > 0 && (
              <div style={noticeStyle("warn")}>
                <div style={{ marginBottom: 4 }}>{replacing ? "Replaced. Note:" : "Uploaded. Note:"}</div>
                <ul style={{ margin: 0, paddingLeft: 18, fontWeight: 400 }}>
                  {warnings.map((w, i) => (
                    <li key={i} style={{ marginTop: 2 }}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
            {resultSlug && <BootCheck slug={resultSlug} />}
          </>
        ) : (
          <>
            {replacing && (
              <div style={{ fontSize: 13, lineHeight: 1.5, color: "#6E6A62" }}>
                Replacing <strong style={{ color: "#2C2932" }}>{existing!.title}</strong> swaps its HTML only — its
                publish status and link (<code>/d/{existing!.slug}</code>) stay exactly as they are.
              </div>
            )}

            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={label}>Title</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Deck title" style={field} autoFocus />
            </label>

            {!replacing && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={label}>Slug (optional)</span>
                  <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="auto from title" style={field} />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={label}>Date (optional)</span>
                  <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={field} />
                </label>
              </div>
            )}

            {!replacing && (
              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={label}>Description (optional)</span>
                <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="One-line summary" style={field} />
              </label>
            )}

            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={label}>HTML{replacing ? " (new content)" : ""}</span>
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  style={{ fontFamily: "inherit", fontSize: 11.5, fontWeight: 500, color: "#4A4750", background: "rgba(255,255,255,0.7)", border: "1px solid rgba(60,55,45,0.14)", borderRadius: 8, padding: "4px 9px", cursor: "pointer" }}
                >
                  Choose .html file
                </button>
                <input ref={fileRef} type="file" accept=".html,.htm,text/html" onChange={(e) => pickFile(e.target.files?.[0])} style={{ display: "none" }} />
              </div>
              <textarea
                value={html}
                onChange={(e) => setHtml(e.target.value)}
                placeholder="<!doctype html> … paste a self-contained HTML deck"
                spellCheck={false}
                style={{ ...field, height: 200, padding: 12, resize: "vertical", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12.5, lineHeight: 1.5 }}
              />
            </label>

            {/* The validator's structural rejection (422) — the primary Phase-2
                feedback loop. Lead with the exact fix list; the generic one-liner
                below only shows for the OTHER failure modes (auth/slug/size/…). */}
            {issues.length > 0 && (
              <div style={noticeStyle("error")}>
                <div style={{ marginBottom: 4 }}>This deck can't be used yet:</div>
                <ul style={{ margin: 0, paddingLeft: 18, fontWeight: 400 }}>
                  {issues.map((it, i) => (
                    <li key={i} style={{ marginTop: 2 }}>{it}</li>
                  ))}
                </ul>
              </div>
            )}

            {error && <div style={noticeStyle("error")}>{error}</div>}
          </>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 2 }}>
          {done ? (
            // The store already succeeded; the only action left is to leave —
            // which refreshes the grid so the new/updated card shows (via onDone).
            <button
              type="button"
              className="lm-panel-btn"
              onClick={onDone}
              style={{ fontFamily: "inherit", fontSize: 14, fontWeight: 500, color: "#F4F2EC", background: "#2C2A31", border: "none", borderRadius: 11, padding: "0 22px", height: 42, cursor: "pointer" }}
            >
              Done
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={dismiss}
                disabled={saving}
                style={{ fontFamily: "inherit", fontSize: 14, fontWeight: 400, color: "#4A4750", background: "transparent", border: "1px solid rgba(60,55,45,0.18)", borderRadius: 11, padding: "0 18px", height: 42, cursor: saving ? "default" : "pointer" }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="lm-panel-btn"
                onClick={submit}
                disabled={saving}
                style={{ fontFamily: "inherit", fontSize: 14, fontWeight: 500, color: "#F4F2EC", background: "#2C2A31", border: "none", borderRadius: 11, padding: "0 22px", height: 42, cursor: saving ? "default" : "pointer", opacity: saving ? 0.75 : 1 }}
              >
                {saving ? "Saving…" : replacing ? "Replace content" : "Upload deck"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- import-from-markdown panel ---------------------------------------------

type ImportTheme = "light" | "dark" | "warm";
const IMPORT_THEMES: { key: ImportTheme; label: string }[] = [
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
  { key: "warm", label: "Warm" },
];

// A 2-slide starter dropped into the textarea by "Paste an example" — it shows
// the exact `---` slide separator and that a heading opens each slide, so a
// first-time importer sees the shape of a valid deck at a glance.
const SAMPLE_MARKDOWN = `# Welcome to VibeDeck
Turn plain Markdown into a live deck.

- Write each slide as Markdown
- Separate slides with a line that is only ---
- Import lands the deck hidden, owned by you

---

# How a slide is built
The first heading becomes the slide's title.

Everything under it — text, **bold**, _italic_, and lists — fills the slide. Add as many slides as you like.`;

// The Markdown-import sibling of UploadPanel: same modal chrome, the same
// idle → saving → done state machine, the same close idiom (dismiss routes to
// onClose before a store and onDone after, never mid-save), and the same
// noticeStyle vocabulary. It POSTs Markdown to /api/admin/decks/import; on
// success a hidden deck the importer owns is created (slugs + AI grounding
// derived server-side), then the grid refreshes so its card appears.
function ImportPanel({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [markdown, setMarkdown] = useState("");
  const [title, setTitle] = useState("");
  const [theme, setTheme] = useState<ImportTheme>("warm");
  // idle → saving → done. "done" holds the panel open on a result view AFTER a
  // successful import so any warnings can show and the presenter can jump to the
  // editor; it no longer auto-closes on success (see submit / dismiss).
  const [status, setStatus] = useState<"idle" | "saving" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  // The 422 invalid_deck issues — shown UNDER the friendly one-liner so the
  // presenter sees both "what went wrong" and "exactly what to fix".
  const [issues, setIssues] = useState<string[]>([]);
  // Non-blocking warnings returned alongside a successful import (201).
  const [warnings, setWarnings] = useState<string[]>([]);
  const [resultSlug, setResultSlug] = useState<string | null>(null);
  const [slideCount, setSlideCount] = useState<number | null>(null);

  // One close path for every dismissal (backdrop, Esc, ✕, Cancel/Done). Never
  // mid-save. Once the deck is stored ("done"), a close MUST refresh the grid so
  // the new card appears — route through onDone; before that a plain onClose.
  const dismiss = useCallback(() => {
    if (status === "saving") return;
    if (status === "done") onDone();
    else onClose();
  }, [status, onClose, onDone]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") dismiss();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismiss]);

  async function submit() {
    setError(null);
    setIssues([]);
    if (!markdown.trim()) {
      setError("Paste some Markdown first.");
      return;
    }
    setStatus("saving");
    try {
      const res = await fetch("/api/admin/decks/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          markdown,
          theme,
          // Only send a title when set — an empty one must trigger the server's
          // heading-derived default, not override it with "".
          ...(title.trim() ? { title: title.trim() } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        slug?: string;
        slideCount?: number;
        warnings?: string[];
        issues?: string[];
        error?: string;
      };
      if (res.ok) {
        // Stored. DON'T close yet — switch to the result view so any warnings
        // show and the presenter can open the editor; they dismiss it (→ refresh).
        setResultSlug(data.slug ?? null);
        setSlideCount(typeof data.slideCount === "number" ? data.slideCount : null);
        setWarnings(Array.isArray(data.warnings) ? data.warnings : []);
        setStatus("done");
        return;
      }
      // Friendly one-liner for every failure; invalid_deck ALSO carries `issues`,
      // so surface that fix-list under the line (see the error notice below).
      setError(importErrorMessage(res.status, data.error));
      if (data.error === "invalid_deck" && Array.isArray(data.issues)) {
        setIssues(data.issues);
      }
      setStatus("idle");
    } catch {
      setError("Network error — try again.");
      setStatus("idle");
    }
  }

  const saving = status === "saving";
  const done = status === "done";
  const label: React.CSSProperties = { fontSize: 11, fontWeight: 500, letterSpacing: "0.1em", textTransform: "uppercase", color: "#9A958A" };
  const field: React.CSSProperties = {
    width: "100%",
    height: 40,
    padding: "0 12px",
    borderRadius: 11,
    border: "1px solid rgba(60,55,45,0.16)",
    background: "rgba(255,255,255,0.7)",
    fontFamily: "inherit",
    fontSize: 14,
    color: "#2C2932",
    outline: "none",
    boxSizing: "border-box",
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Import a deck from Markdown"
      onClick={dismiss}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "rgba(30,28,24,0.34)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(640px, 100%)",
          maxHeight: "calc(100vh - 48px)",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 16,
          padding: 26,
          borderRadius: 22,
          background: "#F4F2EC",
          border: "1px solid rgba(255,255,255,0.8)",
          boxShadow: "0 30px 70px -30px rgba(40,35,25,0.6)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 20, fontWeight: 500, letterSpacing: "-0.01em", color: "#262229" }}>
            {done ? "Deck created" : "Import from Markdown"}
          </div>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Close"
            style={{ width: 32, height: 32, borderRadius: 10, border: "1px solid rgba(60,55,45,0.14)", background: "rgba(255,255,255,0.6)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#6E6A62" strokeWidth={1.5} strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        {done ? (
          // RESULT VIEW — the deck is already stored; confirm it, surface any
          // non-blocking warnings, and offer a jump to the editor. The presenter
          // dismisses via Done / ✕ / Esc / backdrop (all → dismiss → refresh).
          <>
            <div style={noticeStyle("ok")}>
              {slideCount != null ? `Built ${slideCount} ${slideCount === 1 ? "slide" : "slides"}. ` : ""}
              Saved as a hidden deck — set it Public or Live from its card when you're ready.
            </div>
            {warnings.length > 0 && (
              <div style={noticeStyle("warn")}>
                <div style={{ marginBottom: 4 }}>Imported. Note:</div>
                <ul style={{ margin: 0, paddingLeft: 18, fontWeight: 400 }}>
                  {warnings.map((w, i) => (
                    <li key={i} style={{ marginTop: 2 }}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : (
          <>
            <div style={{ fontSize: 13, lineHeight: 1.5, color: "#6E6A62" }}>
              Paste Markdown to build a deck. It lands hidden and owned by you, with AI context
              derived automatically — publish it from its card when you're ready.
            </div>

            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={label}>Title (optional)</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Auto from the first heading" style={field} />
            </label>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={label}>Theme</span>
              <div style={{ display: "inline-flex", alignSelf: "flex-start", alignItems: "center", gap: 2, padding: 3, borderRadius: 11, background: "rgba(40,38,32,0.05)", border: "1px solid rgba(60,55,45,0.14)" }}>
                {IMPORT_THEMES.map((opt) => {
                  const active = opt.key === theme;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => setTheme(opt.key)}
                      aria-pressed={active}
                      disabled={saving}
                      style={{
                        height: 30,
                        padding: "0 16px",
                        borderRadius: 8,
                        border: "none",
                        fontFamily: "inherit",
                        fontSize: 13,
                        fontWeight: active ? 600 : 500,
                        cursor: active ? "default" : "pointer",
                        background: active ? "#2C2A31" : "transparent",
                        color: active ? "#F4F2EC" : "#8A857C",
                        transition: "background .15s, color .15s",
                      }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={label}>Markdown</span>
                <button
                  type="button"
                  onClick={() => setMarkdown(SAMPLE_MARKDOWN)}
                  style={{ fontFamily: "inherit", fontSize: 11.5, fontWeight: 500, color: "#4A4750", background: "rgba(255,255,255,0.7)", border: "1px solid rgba(60,55,45,0.14)", borderRadius: 8, padding: "4px 9px", cursor: "pointer" }}
                >
                  Paste an example
                </button>
              </div>
              <textarea
                value={markdown}
                onChange={(e) => setMarkdown(e.target.value)}
                placeholder={"# Slide one\n\nYour first slide…\n\n---\n\n# Slide two\n\nYour second slide…"}
                spellCheck={false}
                autoFocus
                style={{ ...field, height: 240, padding: 12, resize: "vertical", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12.5, lineHeight: 1.5 }}
              />
              <span style={{ fontSize: 12, color: "#8A857C" }}>Separate slides with a line containing only ---</span>
            </label>

            {/* One error box: the friendly one-liner leads, and when the server
                returned invalid_deck issues, the fix-list follows beneath it. */}
            {(error || issues.length > 0) && (
              <div style={noticeStyle("error")}>
                {error && <div style={{ marginBottom: issues.length > 0 ? 4 : 0 }}>{error}</div>}
                {issues.length > 0 && (
                  <ul style={{ margin: 0, paddingLeft: 18, fontWeight: 400 }}>
                    {issues.map((it, i) => (
                      <li key={i} style={{ marginTop: 2 }}>{it}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 2 }}>
          {done ? (
            <>
              {resultSlug && (
                <Link
                  href={`/dashboard/edit/${resultSlug}`}
                  style={{ display: "inline-flex", alignItems: "center", fontFamily: "inherit", fontSize: 14, fontWeight: 400, color: "#4A4750", background: "transparent", border: "1px solid rgba(60,55,45,0.18)", borderRadius: 11, padding: "0 18px", height: 42, textDecoration: "none" }}
                >
                  Open in editor
                </Link>
              )}
              <button
                type="button"
                className="lm-panel-btn"
                onClick={onDone}
                style={{ fontFamily: "inherit", fontSize: 14, fontWeight: 500, color: "#F4F2EC", background: "#2C2A31", border: "none", borderRadius: 11, padding: "0 22px", height: 42, cursor: "pointer" }}
              >
                Done
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={dismiss}
                disabled={saving}
                style={{ fontFamily: "inherit", fontSize: 14, fontWeight: 400, color: "#4A4750", background: "transparent", border: "1px solid rgba(60,55,45,0.18)", borderRadius: 11, padding: "0 18px", height: 42, cursor: saving ? "default" : "pointer" }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="lm-panel-btn"
                onClick={submit}
                disabled={saving}
                style={{ fontFamily: "inherit", fontSize: 14, fontWeight: 500, color: "#F4F2EC", background: "#2C2A31", border: "none", borderRadius: 11, padding: "0 22px", height: 42, cursor: saving ? "default" : "pointer", opacity: saving ? 0.75 : 1 }}
              >
                {saving ? "Creating…" : "Create deck"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- post-upload boot check -------------------------------------------------

// After a deck is stored, prove it actually RUNS: mint a signed preview URL, load
// the real cross-origin /d-content deck in a HIDDEN, hard-sandboxed iframe, and
// wait for the shared runtime's bridge to report a slide count. Server-side
// validation checks structure; this is the "does it really boot in a browser"
// confirmation that structural checks can't give. Advisory only — the deck is
// already stored (unpublished), so a failure here is a warning, not a hard error.
//
// SECURITY — this reuses UploadedDeckFrame's trust model verbatim (see its header
// §1), and the two invariants below are NON-NEGOTIABLE:
//   1. sandbox="allow-scripts" with NO allow-same-origin → the deck runs in an
//      opaque origin, contained exactly as it is for real viewers. `src` is the
//      REAL /d-content URL. We NEVER use srcdoc, a blob: URL, or a same-origin
//      document to load the deck HTML — any of those would execute untrusted
//      uploaded HTML on the APP (dashboard) origin, recreating the very same-
//      origin-XSS hole the separate DECK_ORIGIN mechanism exists to prevent.
//   2. We accept a message ONLY when event.source === our iframe's contentWindow
//      (unforgeable window identity) AND event.data.source === "deck". We do NOT
//      check event.origin — it's the literal string "null" for an opaque-origin
//      sandbox, so checking it would reject every real message.
type BootState =
  | { kind: "checking" }
  | { kind: "unavailable"; reason: string }
  | { kind: "runs"; total: number }
  | { kind: "failed" };

// The bridge fires `ready` (no total) then its first `slidechange` (with total)
// within a few frames of boot; 6s is generous headroom for a slow cold start
// while staying short enough that "didn't boot" feels prompt.
const BOOT_TIMEOUT_MS = 6000;

function BootCheck({ slug }: { slug: string }) {
  const [boot, setBoot] = useState<BootState>({ kind: "checking" });

  useEffect(() => {
    // One `settled` guard + one cleanup closure shared by every async exit, so
    // the listener / iframe / timer are torn down exactly once — whether we
    // succeed, time out, or the panel unmounts mid-check (React runs the returned
    // fn then). No leaked iframes or dangling message listeners.
    let settled = false;
    let iframe: HTMLIFrameElement | null = null;
    let timer: number | undefined;
    let onMessage: ((e: MessageEvent) => void) | null = null;

    function cleanup() {
      if (timer !== undefined) window.clearTimeout(timer);
      if (onMessage) window.removeEventListener("message", onMessage);
      if (iframe && iframe.parentNode) iframe.parentNode.removeChild(iframe);
      timer = undefined;
      onMessage = null;
      iframe = null;
    }

    void (async () => {
      // 1. Mint the signed preview URL (same-origin fetch → cookie + Origin sent
      //    automatically, so the presenter gate + CSRF check pass). A non-200
      //    (e.g. 503 deck_origin_unset) means the live check just isn't available
      //    — NOT that the deck is bad; it's already stored. Degrade to a neutral
      //    note, never an error.
      let url: string | undefined;
      try {
        const res = await fetch(`/api/admin/decks/${slug}/preview`);
        const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
        if (!res.ok || !data.url) {
          if (!settled) {
            settled = true;
            setBoot({
              kind: "unavailable",
              reason: data.error === "deck_origin_unset" ? "deck origin not configured" : "the live check isn't available",
            });
          }
          return;
        }
        url = data.url;
      } catch {
        if (!settled) {
          settled = true;
          setBoot({ kind: "unavailable", reason: "the live check isn't available" });
        }
        return;
      }
      if (settled) return; // panel closed while the token minted

      // 2. Hidden, hard-sandboxed iframe pointed at the REAL cross-origin deck.
      //    allow-scripts WITHOUT allow-same-origin = opaque origin, the exact
      //    containment real viewers get. `src` is the /d-content URL — never
      //    srcdoc/blob: (that would run untrusted HTML on the app origin).
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("aria-hidden", "true");
      frame.setAttribute("tabindex", "-1");
      frame.title = "Deck boot check";
      frame.style.cssText = "position:absolute; left:-9999px; top:0; width:0; height:0; border:0; opacity:0; pointer-events:none;";
      frame.src = url;
      // onLoad nudge: the deck may fire its first report before our listener is
      // live (boot race) — ask it to re-emit. Empty control ping, targetOrigin
      // "*" (an opaque frame has no specific origin to target). Mirrors
      // UploadedDeckFrame's requestReport.
      frame.addEventListener("load", () => {
        try {
          frame.contentWindow?.postMessage({ type: "deck:report" }, "*");
        } catch {
          /* ignore */
        }
      });
      iframe = frame;

      onMessage = (e: MessageEvent) => {
        const d = (e.data ?? {}) as { source?: string; type?: string; total?: number };
        // SECURITY GUARD — our OWN frame's window (unforgeable object identity)
        // AND the deck marker. NOT event.origin (it's "null" for the sandbox).
        if (!(e.source === frame.contentWindow && d.source === "deck")) return;
        // SUCCESS: a slidechange (or ready) reporting a real slide count. The
        // bridge's `ready` carries no total, so in practice this trips on the
        // first slidechange — exactly the "booted and enumerated slides" proof.
        if ((d.type === "slidechange" || d.type === "ready") && typeof d.total === "number" && d.total > 0) {
          if (!settled) {
            settled = true;
            setBoot({ kind: "runs", total: d.total });
          }
          cleanup();
        }
      };
      window.addEventListener("message", onMessage);
      document.body.appendChild(frame);

      // 3. Bounded wait: nothing reported a slide count in time → the deck didn't
      //    boot under the runtime. Advisory warning — it's still stored.
      timer = window.setTimeout(() => {
        if (!settled) {
          settled = true;
          setBoot({ kind: "failed" });
        }
        cleanup();
      }, BOOT_TIMEOUT_MS);
    })();

    return () => {
      settled = true;
      cleanup();
    };
  }, [slug]);

  if (boot.kind === "checking") {
    return <div style={noticeStyle("muted")}>Checking it runs in a browser…</div>;
  }
  if (boot.kind === "unavailable") {
    // The deck stored fine; the live check just couldn't run. Neutral, not an error.
    return <div style={noticeStyle("muted")}>Preview unavailable ({boot.reason}) — the deck is stored either way.</div>;
  }
  if (boot.kind === "runs") {
    return (
      <div style={noticeStyle("ok")}>
        Runs ✓ — {boot.total} {boot.total === 1 ? "slide" : "slides"}
      </div>
    );
  }
  return (
    <div style={noticeStyle("warn")}>
      This deck didn't boot in a browser — check the structure and use Replace.
    </div>
  );
}

// ---- search results ---------------------------------------------------------

function SearchResults({ results, query, isAdmin }: { results: DeckCard[]; query: string; isAdmin: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase", color: "#9A958A", margin: "2px 0 16px" }}>
        {results.length} {results.length === 1 ? "result" : "results"} for “{query}”
      </div>
      {results.length === 0 ? (
        <p style={{ color: "#6E6A62", fontSize: 16 }}>No decks match “{query}”.</p>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
          {results.map((d) => (
            <SearchResultCard key={d.slug} d={d} isAdmin={isAdmin} />
          ))}
        </div>
      )}
    </div>
  );
}

function SearchResultCard({ d, isAdmin }: { d: DeckCard; isAdmin: boolean }) {
  const ctx = usePublish();
  // Phase 4 — the owner-only overlays (publish control, replace/delete) render
  // only when this session may manage the deck. The card's hidden styling still
  // tracks the live status regardless.
  const canManage = d.canManage === true;
  const status = ctx ? ctx.statusOf(d.slug) : d.publishStatus;
  const hidden = status === "unpublished";
  return (
    // The control is a SIBLING under the card link (never nested — no anchor in
    // an anchor), so it can POST without triggering the card's navigation.
    <div style={{ display: "flex", flexDirection: "column" }}>
      <Link
        href={`/d/${d.slug}`}
        className="lm-card"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          padding: "22px 22px 20px",
          borderRadius: 18,
          textDecoration: "none",
          color: "#2C2932",
          background: "rgba(255,255,255,0.5)",
          border: hidden ? "1px dashed rgba(44,42,49,0.4)" : "1px solid rgba(255,255,255,0.72)",
          filter: hidden ? "saturate(0.6) brightness(0.99)" : undefined,
          backdropFilter: "blur(16px)",
          WebkitBackdropFilter: "blur(16px)",
          boxShadow: "0 10px 28px -18px rgba(60,55,45,0.4)",
          transition: "transform .18s cubic-bezier(.2,.6,.2,1), box-shadow .18s cubic-bezier(.2,.6,.2,1)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#9A958A" }}>
          <span>{d.date}</span>
          <span>
            {d.slideCount} {d.slideCount === 1 ? "slide" : "slides"}
          </span>
        </div>
        <div style={{ fontSize: 20, fontWeight: 500, letterSpacing: "-0.01em" }}>{d.title}</div>
        {d.description && <div style={{ fontSize: 14, fontWeight: 300, lineHeight: 1.5, color: "#6E6A62" }}>{d.description}</div>}
      </Link>
      {canManage && <PublishControl slug={d.slug} isAdmin={isAdmin} variant="inline" />}
      {canManage && d.kind === "uploaded" && <UploadedActions deck={d} variant="inline" />}
    </div>
  );
}
