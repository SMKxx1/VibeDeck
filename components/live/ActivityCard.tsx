"use client";

// Shared viewer Turn & Talk card — the SINGLE implementation used by both
// LiveDeck and UploadedDeckFrame. Extracted verbatim from LiveDeck, which remains
// the source of truth. In UploadedDeckFrame this renders in PARENT app-chrome
// only; nothing here is ever posted into the sandboxed deck frame.

import type { Activity } from "./types";
import { useNow } from "./useNow";
import { pollBadge } from "./PollCard";
import { recapDismissBtn } from "./RecapCard";

// The viewer's Turn & Talk card: the presenter broadcast a discussion/exercise
// prompt with a synchronized countdown. The MM:SS timer renders client-side from
// `endsAt` (everyone counts down to the same wall-clock instant); when it hits 0
// it lingers briefly as "time's up", and the presenter's Regroup clears it
// everywhere via the session poll. Hiding is local; a new activity id re-shows.
export function ActivityCard({ activity, onHide }: { activity: Activity; onHide: () => void }) {
  const now = useNow(500);
  const remaining = activity.endsAt - now;
  // Past the brief "time's up" linger the card is over — the next session tick
  // stops delivering the activity anyway (the server filters ended ones).
  if (remaining <= -10_000) return null;
  const done = remaining <= 0;
  const secs = Math.max(0, Math.ceil(remaining / 1000));
  const mm = String(Math.floor(secs / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  return (
    <div style={activityCardWrap} role="status" aria-label="Group activity">
      <div style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <span style={pollBadge}>⏱ Turn &amp; talk</span>
        <button onClick={onHide} title="Hide" aria-label="Hide activity" style={recapDismissBtn}>
          ✕
        </button>
      </div>
      <div style={{ fontSize: 17, fontWeight: 500, color: "#262229", lineHeight: 1.45, whiteSpace: "pre-wrap" }}>
        {activity.prompt}
      </div>
      <div style={activityTimer(done)} aria-live={done ? "assertive" : "off"}>
        {done ? "Time's up — regroup!" : `${mm}:${ss}`}
      </div>
      {!done && activity.followUp === "poll" && (
        <div style={activityNote}>Up next: a quick poll on this.</div>
      )}
      {!done && activity.followUp === "pinboard" && (
        <div style={activityNote}>Up next: share your link on the pinboard.</div>
      )}
    </div>
  );
}

// Larger than the recap card — during a turn-and-talk the activity IS the focus.
const activityCardWrap: React.CSSProperties = {
  width: "100%",
  maxHeight: "min(60vh, 440px)",
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  textAlign: "center",
  gap: 12,
  padding: "18px 20px 22px",
  borderRadius: 20,
  background: "rgba(255,255,255,0.88)",
  border: "1px solid rgba(255,255,255,0.9)",
  backdropFilter: "blur(16px)",
  WebkitBackdropFilter: "blur(16px)",
  boxShadow: "0 26px 65px -30px rgba(60,55,45,0.65)",
  fontFamily: '"Outfit", system-ui, sans-serif',
};

function activityTimer(done: boolean): React.CSSProperties {
  return {
    fontVariantNumeric: "tabular-nums",
    fontSize: done ? 21 : 44,
    fontWeight: 600,
    letterSpacing: done ? "0" : "0.03em",
    lineHeight: 1.1,
    color: done ? "#B5331F" : "#2C2A31",
  };
}

const activityNote: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#4B5A16",
  background: "rgba(191,224,72,0.2)",
  border: "1px solid rgba(191,224,72,0.45)",
  borderRadius: 9,
  padding: "6px 10px",
};
