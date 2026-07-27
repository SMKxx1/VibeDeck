"use client";

// Shared live-room chrome (glass chips, pills and the top-cluster toggles) — the
// SINGLE implementation used by both LiveDeck and UploadedDeckFrame. Extracted
// verbatim from LiveDeck, which remains the source of truth.

export function glassChip(): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    height: 34,
    padding: "0 13px",
    borderRadius: 12,
    fontFamily: '"Outfit", system-ui, sans-serif',
    fontSize: 12.5,
    fontWeight: 500,
    color: "#2C2A31",
    background: "rgba(255,255,255,0.62)",
    border: "1px solid rgba(255,255,255,0.85)",
    backdropFilter: "blur(14px)",
    WebkitBackdropFilter: "blur(14px)",
    boxShadow: "0 6px 18px -12px rgba(60,55,45,0.4)",
    whiteSpace: "nowrap",
  };
}

export function pill(bg: string, fg: string): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    height: 34,
    padding: "0 14px",
    borderRadius: 12,
    border: "none",
    cursor: "pointer",
    fontFamily: '"Outfit", system-ui, sans-serif',
    fontSize: 12.5,
    fontWeight: 500,
    color: fg,
    background: bg,
    whiteSpace: "nowrap",
    boxShadow: "0 6px 18px -12px rgba(60,55,45,0.4)",
  };
}

export function FullscreenButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      aria-label={active ? "Exit fullscreen" : "Enter fullscreen"}
      title={active ? "Exit fullscreen" : "Fullscreen"}
      style={{
        ...glassChip(),
        width: 34,
        padding: 0,
        justifyContent: "center",
        cursor: "pointer",
        fontSize: 15,
        lineHeight: 1,
      }}
    >
      {active ? "✕" : "⛶"}
    </button>
  );
}

export function FollowToggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      title={on ? "Following the presenter — click to explore on your own" : "Explore mode — click to follow the presenter"}
      style={{ ...pill(on ? "#2C2A31" : "rgba(255,255,255,0.62)", on ? "#F4F2EC" : "#2C2A31"), border: on ? "none" : "1px solid rgba(255,255,255,0.85)", gap: 8 }}
    >
      <span
        style={{
          width: 26,
          height: 15,
          borderRadius: 999,
          background: on ? "#BFE048" : "rgba(60,55,45,0.25)",
          position: "relative",
          transition: "background .16s",
          flex: "0 0 auto",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: on ? 13 : 2,
            width: 11,
            height: 11,
            borderRadius: "50%",
            background: "#fff",
            transition: "left .16s",
            boxShadow: "0 1px 3px rgba(0,0,0,.28)",
          }}
        />
      </span>
      Auto-follow
    </button>
  );
}

export function ChatButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={open}
      title="Ask about this slide"
      style={{ ...pill(open ? "#2C2A31" : "rgba(255,255,255,0.62)", open ? "#F4F2EC" : "#2C2A31"), border: open ? "none" : "1px solid rgba(255,255,255,0.85)", gap: 7 }}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      Ask
    </button>
  );
}

// Toggle for the viewer's Q&A queue (#5). Shows the last-known question count once
// the panel has fetched it. Distinct from the tutor "Ask" chat above.
export function QnaButton({ open, count, onClick }: { open: boolean; count: number; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={open}
      title="See the room's questions, upvote, or ask your own"
      style={{ ...pill(open ? "#2C2A31" : "rgba(255,255,255,0.62)", open ? "#F4F2EC" : "#2C2A31"), border: open ? "none" : "1px solid rgba(255,255,255,0.85)", gap: 6 }}
    >
      <span aria-hidden style={{ fontSize: 13, lineHeight: 1 }}>❓</span>
      Questions{count > 0 ? ` (${count})` : ""}
    </button>
  );
}
