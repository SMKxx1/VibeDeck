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

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import Link from "next/link";

export type PublishStatus = "main" | "normal" | "unpublished";

export interface DeckCard {
  slug: string;
  title: string;
  date: string;
  description: string;
  slideCount: number;
  publishStatus: PublishStatus;
  // Present only for self-contained HTML decks. Gates the "Live" segment: "/"
  // renders the main deck solely through this iframe URL, so a deck without one
  // can never legitimately go Live (the server rejects it too).
  embedUrl?: string;
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
function PublishControl({ slug, variant = "overlay" }: { slug: string; variant?: "overlay" | "inline" }) {
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
          // Disable ONLY the Live segment for a non-embed deck, and only when it
          // isn't already active (an existing bad 'main' stays shown as Live so it
          // mirrors the DB). A disabled segment is left visible, not hidden, so the
          // option still reads as real — just unavailable for this deck type.
          const blocked = seg.key === "main" && !embeddable && !active;
          const disabled = saving || blocked;
          return (
            <button
              key={seg.key}
              type="button"
              title={blocked ? "This deck type can't be shown on the home page ( / ) — only self-contained HTML decks can go Live." : seg.title}
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
  gridColumn: string;
  gridRow: string;
  background: string;
  boxShadow: string;
  radius?: number;
  children: React.ReactNode;
}) {
  const { href, editHref, publishSlug, gridColumn, gridRow, background, boxShadow, radius = 22, children } = props;
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
      {editHref && <EditPill href={editHref} />}
      {publishSlug && <PublishControl slug={publishSlug} />}
    </div>
  );
}

// ---- main -------------------------------------------------------------------

export function DeckLibrary({ decks }: { decks: DeckCard[] }) {
  const [q, setQ] = useState("");
  const [name, setName] = useState<string | null>(null);

  // Live publish state, seeded from the server-rendered props and thereafter the
  // single source of truth for every card. The API's response statusMap is the
  // authority on success (it reflects the demote-the-old-main side effect), so we
  // merge it wholesale rather than optimistically flipping just the clicked slug.
  const [statusMap, setStatusMap] = useState<Record<string, PublishStatus>>(() =>
    Object.fromEntries(decks.map((d) => [d.slug, d.publishStatus])),
  );
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  // Which decks may be featured on "/" (Live). Only self-contained HTML decks
  // carry an embedUrl, and "/" renders the main deck solely through that iframe —
  // so this set gates the Live segment. Derived from the (stable) server props.
  const embeddable = useMemo(
    () => new Set(decks.filter((d) => d.embedUrl).map((d) => d.slug)),
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
              <SearchResults results={filtered} query={q} />
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0,0.92fr) minmax(0,1.5fr)", gap: 22, alignItems: "stretch" }}>
                <Hero name={name} deckWord={numberWord(cardCount)} totalSlides={totalSlides} resume={resume} />
                <Bento decks={decks} />
              </div>
            )}
          </div>
        </div>
      </div>

      <style>{`
        .lm-card:hover { transform: translateY(-3px); box-shadow: 0 22px 46px -22px rgba(60,55,45,0.55) !important; }
        .lm-new:hover { background: rgba(255,255,255,0.6) !important; }
        .lm-edit:hover { background: rgba(30,28,26,0.52) !important; border-color: rgba(255,255,255,0.55) !important; }
        .lm-pub-seg-o:hover { background: rgba(255,255,255,0.16) !important; }
        .lm-pub-seg-i:hover { background: rgba(40,38,32,0.07) !important; }
      `}</style>
    </div>
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

function Bento({ decks }: { decks: DeckCard[] }) {
  // Fill the five deck slots newest-first with real decks, then sample decks so
  // the grid always reads as full. items[0]=featured, [1]=wide, [2]=tall,
  // [3]=small, [4]=wide.
  const real = decks.slice(0, 5);
  const fillers = SAMPLE_DECKS.slice(0, Math.max(0, 5 - real.length));
  const items: Item[] = [...real, ...fillers.map((f) => ({ ...f, sample: true as const }))];
  const [c0, c1, c2, c3, c4] = items;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4,minmax(0,1fr))", gridTemplateRows: "repeat(3,158px)", gap: 14 }}>
      {c0 && <FeaturedCard item={c0} />}
      {c1 && <WideGreenCard item={c1} />}
      {c2 && <TallGoldCard item={c2} />}
      {c3 && <SmallCoralCard item={c3} />}
      {c4 && <WideLimeCard item={c4} />}
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

function FeaturedCard({ item }: { item: Item }) {
  return (
    <BentoCard
      href={hrefOf(item)}
      editHref={editHrefOf(item)}
      publishSlug={slugOf(item)}
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

function WideGreenCard({ item }: { item: Item }) {
  return (
    <BentoCard
      href={hrefOf(item)}
      editHref={editHrefOf(item)}
      publishSlug={slugOf(item)}
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

function TallGoldCard({ item }: { item: Item }) {
  return (
    <BentoCard
      href={hrefOf(item)}
      editHref={editHrefOf(item)}
      publishSlug={slugOf(item)}
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

function SmallCoralCard({ item }: { item: Item }) {
  return (
    <BentoCard
      href={hrefOf(item)}
      editHref={editHrefOf(item)}
      publishSlug={slugOf(item)}
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

function WideLimeCard({ item }: { item: Item }) {
  return (
    <BentoCard
      href={hrefOf(item)}
      editHref={editHrefOf(item)}
      publishSlug={slugOf(item)}
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

function NewDeckCard() {
  return (
    <div
      className="lm-new"
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
      }}
      title="Add a deck: create a file in lib/decks/, register it, and deploy."
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
    </div>
  );
}

// ---- search results ---------------------------------------------------------

function SearchResults({ results, query }: { results: DeckCard[]; query: string }) {
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
            <SearchResultCard key={d.slug} d={d} />
          ))}
        </div>
      )}
    </div>
  );
}

function SearchResultCard({ d }: { d: DeckCard }) {
  const ctx = usePublish();
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
      <PublishControl slug={d.slug} variant="inline" />
    </div>
  );
}
