"use client";

// Insight Engine UI, shared by BOTH presenter surfaces (PresenterConsole for
// embed decks, UploadedDeckFrame's presenter path for uploaded decks):
//
//   PulseHeatStrip — the live "where is the room struggling" strip: one cell per
//     slide, color intensity = that slide's total struggle signals (tutor
//     questions, reframes, catch-ups, "I'm lost" taps, wrong poll votes), with a
//     per-signal breakdown in the tooltip. Pure presentation — the PARENT polls
//     GET /api/pulse on its existing presenter tick and passes the slides in.
//
//   InsightPanel — the end-of-session debrief: shows the live breakdown, and one
//     button that POSTs /api/pulse {action:"debrief"} to snapshot the aggregates
//     and get the AI teaching debrief (+ prior runs of the same deck to compare).
//
// Everything rendered here is NUMERIC aggregates or the deck-facing debrief —
// no viewer names/questions exist anywhere in this data (lib/pulse.ts).

import { useState } from "react";

export interface PulseSlideDto {
  index: number;
  ask: number;
  explain: number;
  catchup: number;
  lost: number;
  pollWrong: number;
  total: number;
}

interface ReportDto {
  id: string;
  deckSlug: string;
  startedAt: number | null;
  endedAt: number;
  aggregates: PulseSlideDto[];
  debrief: string | null;
}

// The two presenter surfaces have opposite chrome (console = dark, uploaded-deck
// frame = light glass), so every color routes through this tiny palette.
type Variant = "dark" | "light";
const PALETTES = {
  dark: {
    text: "#F4F2EC",
    dim: "#9A958A",
    cellEmpty: "rgba(255,255,255,0.08)",
    border: "rgba(255,255,255,0.14)",
    panelBg: "rgba(255,255,255,0.04)",
    cardBg: "rgba(255,255,255,0.05)",
    accent: "#BFE048",
    accentFg: "#1B1B20",
    error: "#FF6B4A",
  },
  light: {
    text: "#2C2A31",
    dim: "#6E6A61",
    cellEmpty: "rgba(44,42,49,0.10)",
    border: "rgba(44,42,49,0.18)",
    panelBg: "rgba(255,255,255,0.92)",
    cardBg: "rgba(44,42,49,0.05)",
    accent: "#2C2A31",
    accentFg: "#F4F2EC",
    error: "#B5331F",
  },
} as const;

function breakdown(s: PulseSlideDto): string {
  const parts: string[] = [];
  if (s.ask) parts.push(`${s.ask} question${s.ask === 1 ? "" : "s"}`);
  if (s.explain) parts.push(`${s.explain} reframe${s.explain === 1 ? "" : "s"}`);
  if (s.catchup) parts.push(`${s.catchup} catch-up${s.catchup === 1 ? "" : "s"}`);
  if (s.lost) parts.push(`${s.lost} lost`);
  if (s.pollWrong) parts.push(`${s.pollWrong} wrong vote${s.pollWrong === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/**
 * The compact heat strip: one cell per slide (deck order), red intensity scaled
 * to the busiest slide, tooltip = the per-signal breakdown, outline = the slide
 * the presenter is on now. Renders nothing until the deck's slide count is known.
 */
export function PulseHeatStrip({
  slides,
  total,
  currentIndex,
  variant = "dark",
}: {
  slides: PulseSlideDto[];
  total: number;
  currentIndex: number;
  variant?: Variant;
}) {
  const p = PALETTES[variant];
  if (total <= 0) return null;
  const bySlide = new Map(slides.map((s) => [s.index, s]));
  const max = slides.reduce((m, s) => Math.max(m, s.total), 0);
  const cells = [];
  for (let i = 0; i < total; i++) {
    const s = bySlide.get(i);
    // sqrt so a slide with SOME struggle is clearly visible next to the peak.
    const heat = s && max > 0 ? Math.sqrt(s.total / max) : 0;
    const bg = s ? `rgba(214, 69, 39, ${(0.2 + 0.75 * heat).toFixed(2)})` : p.cellEmpty;
    cells.push(
      <span
        key={i}
        title={s ? `Slide ${i + 1} — ${breakdown(s)}` : `Slide ${i + 1} — no struggle signals`}
        style={{
          flex: 1,
          minWidth: 3,
          height: 10,
          borderRadius: 2,
          background: bg,
          outline: i === currentIndex ? `2px solid ${p.accent}` : undefined,
          outlineOffset: 1,
        }}
      />,
    );
  }
  return (
    <div
      role="img"
      aria-label="Confusion heatmap: struggle signals per slide"
      title="Where the room is struggling — darker means more questions, reframes, catch-ups, lost taps and wrong poll votes on that slide"
      style={{ display: "flex", gap: 2, alignItems: "center", width: "100%" }}
    >
      {cells}
    </div>
  );
}

type DebriefState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "done"; debrief: string; persisted: boolean; reports: ReportDto[] };

function mapDebriefError(code: string | undefined, status: number): string {
  switch (code) {
    case "no_data":
      return "No struggle signals recorded yet this session.";
    case "ai_budget_exceeded":
      return "AI is at today's usage limit.";
    case "rate_limited":
      return "Slow down a moment, then try again.";
    case "ai_not_configured":
      return "AI isn't configured.";
    case "timeout":
      return "The AI took too long — try again.";
    default:
      return status >= 500 ? "Couldn't generate — try again." : "Couldn't generate the debrief.";
  }
}

function runDate(r: ReportDto): string {
  return new Date(r.endedAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The insight panel body: live per-slide breakdown + the one-tap AI session
 * debrief (+ prior runs for comparison). Self-contained state; the PARENT
 * provides the positioning wrapper (each surface lays panels out differently).
 */
export function InsightPanel({
  slug,
  slides,
  variant = "dark",
  onDismiss,
}: {
  slug: string;
  slides: PulseSlideDto[];
  variant?: Variant;
  onDismiss: () => void;
}) {
  const p = PALETTES[variant];
  const [state, setState] = useState<DebriefState>({ phase: "idle" });

  async function generate() {
    if (state.phase === "loading") return;
    setState({ phase: "loading" });
    try {
      const res = await fetch("/api/pulse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, action: "debrief" }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        debrief?: string;
        persisted?: boolean;
        reports?: ReportDto[];
      };
      if (!res.ok || !data.debrief) {
        setState({ phase: "error", message: mapDebriefError(data.error, res.status) });
        return;
      }
      setState({
        phase: "done",
        debrief: data.debrief,
        persisted: data.persisted !== false,
        reports: Array.isArray(data.reports) ? data.reports : [],
      });
    } catch {
      setState({ phase: "error", message: "Couldn't generate — try again." });
    }
  }

  const worst = slides.slice().sort((a, b) => b.total - a.total).slice(0, 6);
  const label: React.CSSProperties = {
    fontSize: 10.5,
    fontWeight: 600,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    color: p.dim,
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        minHeight: 0,
        color: p.text,
        fontSize: 13.5,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={label}>Room insights</span>
        <button
          onClick={onDismiss}
          title="Hide panel"
          aria-label="Hide insights panel"
          style={{
            width: 28,
            height: 28,
            flex: "0 0 auto",
            borderRadius: 8,
            border: `1px solid ${p.border}`,
            background: "transparent",
            color: p.dim,
            cursor: "pointer",
            fontSize: 14,
            lineHeight: 1,
            padding: 0,
          }}
        >
          ✕
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
        {/* live breakdown — anonymous counts only */}
        <div>
          <div style={{ ...label, marginBottom: 6 }}>Struggling now</div>
          {worst.length === 0 ? (
            <div style={{ color: p.dim, fontSize: 12.5 }}>
              No struggle signals yet — questions, reframes, catch-ups, “I'm lost” taps and wrong
              poll votes will show up here by slide.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {worst.map((s) => (
                <div key={s.index} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12.5 }}>
                  <span style={{ whiteSpace: "nowrap", fontWeight: 600 }}>Slide {s.index + 1}</span>
                  <span style={{ color: p.dim, textAlign: "right" }}>{breakdown(s)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* the debrief */}
        {state.phase === "done" ? (
          <>
            <div style={{ borderRadius: 10, padding: "12px 14px", background: p.cardBg, border: `1px solid ${p.border}`, whiteSpace: "pre-wrap", lineHeight: 1.55 }}>
              {state.debrief}
            </div>
            <div style={{ fontSize: 11.5, color: state.persisted ? p.dim : p.error }}>
              {state.persisted
                ? "Saved — this run's numbers reset so your next session starts fresh."
                : "Couldn't save the snapshot (database unavailable) — this run's numbers were kept."}
            </div>
            {state.reports.length > 1 && (
              <div>
                <div style={{ ...label, marginBottom: 6 }}>Past runs of this deck</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {state.reports.slice(0, 6).map((r) => (
                    <details key={r.id} style={{ fontSize: 12.5 }}>
                      <summary style={{ cursor: "pointer", color: p.dim }}>
                        {runDate(r)} · {r.aggregates.reduce((n, s) => n + s.total, 0)} signals across{" "}
                        {r.aggregates.length} slide{r.aggregates.length === 1 ? "" : "s"}
                      </summary>
                      <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.5, marginTop: 6 }}>
                        {r.debrief ?? "(no debrief was generated for this run)"}
                      </div>
                    </details>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <button
              onClick={() => void generate()}
              disabled={state.phase === "loading" || slides.length === 0}
              title="Snapshot this session's struggle signals and get AI rework suggestions per slide"
              style={{
                height: 42,
                borderRadius: 10,
                border: 0,
                cursor: state.phase === "loading" || slides.length === 0 ? "default" : "pointer",
                background: p.accent,
                color: p.accentFg,
                fontFamily: "inherit",
                fontSize: 13.5,
                fontWeight: 600,
                opacity: state.phase === "loading" || slides.length === 0 ? 0.55 : 1,
              }}
            >
              {state.phase === "loading" ? "Analyzing the session…" : "✨ End-of-session debrief"}
            </button>
            {state.phase === "error" && (
              <div style={{ fontSize: 12.5, color: p.error }}>{state.message}</div>
            )}
            <div style={{ fontSize: 11.5, color: p.dim, lineHeight: 1.5 }}>
              Snapshots the anonymous per-slide counts and asks the AI for concrete rework
              suggestions. Only numbers are ever stored — never anyone's name or question.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
