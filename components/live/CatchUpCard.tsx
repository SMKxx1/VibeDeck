"use client";

// Shared personal catch-up card — the SINGLE implementation used by both LiveDeck
// and UploadedDeckFrame. Extracted verbatim from LiveDeck, which remains the
// source of truth. In UploadedDeckFrame this renders in PARENT app-chrome only;
// nothing here is ever posted into the sandboxed deck frame.
//
// NOTE: `mapCatchUpError` is deliberately NOT shared — LiveDeck's copy handles an
// extra "password_required" code, so each host keeps its own.

import type { CatchUp } from "./types";
import { pollBadge } from "./PollCard";
import { recapCardWrap, recapDismissBtn } from "./RecapCard";

// This viewer's personal catch-up card: an on-demand AI recap of the slides
// between where they are and the live slide. Local to this tab (nothing is
// broadcast); dismissing aborts any in-flight fetch and clears local state.
export function CatchUpCard({ catchUp, onDismiss }: { catchUp: CatchUp; onDismiss: () => void }) {
  // The recap covers the slides AFTER the viewer's own (they can see theirs).
  const lo = catchUp.from + 2; // first missed slide, 1-based
  const hi = catchUp.to + 1; // the live slide, 1-based
  const range = lo >= hi ? `slide ${hi}` : `slides ${lo}–${hi}`;
  return (
    <div style={recapCardWrap} role="status" aria-label="Catch-up recap">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <span style={pollBadge}>Catch-up · {range}</span>
        <button onClick={onDismiss} title="Dismiss" aria-label="Dismiss catch-up" style={recapDismissBtn}>
          ✕
        </button>
      </div>
      {catchUp.loading ? (
        <div style={{ fontSize: 13, color: "#8A857C", fontStyle: "italic" }}>Summarizing what you missed…</div>
      ) : catchUp.error ? (
        <div style={{ fontSize: 12.5, color: "#B5331F", fontWeight: 500 }}>{catchUp.error}</div>
      ) : (
        <div style={{ fontSize: 13.5, lineHeight: 1.55, color: "#262229", whiteSpace: "pre-wrap" }}>{catchUp.text}</div>
      )}
    </div>
  );
}

// The shared bottom-center column for the recap + catch-up cards: clears the
// poll card (bottom-left) and the Q&A panel (right), and stacks the two cards
// on the rare occasion both are open.
export const centerCardStack: React.CSSProperties = {
  position: "absolute",
  left: "50%",
  bottom: 16,
  transform: "translateX(-50%)",
  zIndex: 39,
  width: "min(460px, calc(100% - 32px))",
  display: "flex",
  flexDirection: "column",
  gap: 10,
};
