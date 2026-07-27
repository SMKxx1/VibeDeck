"use client";

// Shared viewer recap card (comprehension checkpoint) — the SINGLE
// implementation used by both LiveDeck and UploadedDeckFrame. Extracted verbatim
// from LiveDeck, which remains the source of truth. In UploadedDeckFrame this
// renders in PARENT app-chrome only; nothing here is ever posted into the
// sandboxed deck frame.
//
// `recapCardWrap` / `recapDismissBtn` are shared with the catch-up + activity
// cards, so they are exported alongside the card.

import type { Recap } from "./types";
import { pollBadge } from "./PollCard";

// The viewer's recap card (comprehension checkpoint): the presenter pushed a short
// AI recap of the slide because part of the room felt lost. Purely informational —
// one dismiss button, no inputs. Dismissal is local to this viewer.
export function RecapCard({ recap, onDismiss }: { recap: Recap; onDismiss: () => void }) {
  return (
    <div style={recapCardWrap} role="status" aria-label="Recap from the presenter">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <span style={pollBadge}>Recap · slide {recap.slideIndex + 1}</span>
        <button onClick={onDismiss} title="Dismiss" aria-label="Dismiss recap" style={recapDismissBtn}>
          ✕
        </button>
      </div>
      <div style={{ fontSize: 13.5, lineHeight: 1.55, color: "#262229", whiteSpace: "pre-wrap" }}>{recap.text}</div>
    </div>
  );
}

// Positioned by centerCardStack (shared with the catch-up card) — the card
// itself only styles the glass panel.
export const recapCardWrap: React.CSSProperties = {
  width: "100%",
  maxHeight: "min(50vh, 380px)",
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 10,
  padding: "14px 16px",
  borderRadius: 18,
  background: "rgba(255,255,255,0.82)",
  border: "1px solid rgba(255,255,255,0.9)",
  backdropFilter: "blur(16px)",
  WebkitBackdropFilter: "blur(16px)",
  boxShadow: "0 22px 55px -28px rgba(60,55,45,0.6)",
  fontFamily: '"Outfit", system-ui, sans-serif',
};

export const recapDismissBtn: React.CSSProperties = {
  width: 26,
  height: 26,
  flex: "0 0 auto",
  borderRadius: 8,
  border: "1px solid rgba(60,55,45,0.16)",
  background: "rgba(255,255,255,0.62)",
  color: "#2C2A31",
  cursor: "pointer",
  fontSize: 13,
  lineHeight: 1,
  padding: 0,
};
