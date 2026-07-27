"use client";

// Shared viewer live-poll card (#3) + its style helpers — the SINGLE
// implementation used by both LiveDeck and UploadedDeckFrame. Extracted verbatim
// from LiveDeck, which remains the source of truth.
//
// `pollBadge` / `pollNameBtn` / the poll result styles are also reused by the
// other shared cards (and, in UploadedDeckFrame, by its presenter panels), so
// they are exported alongside the card.

import type { ViewerPoll } from "./types";

// The viewer's live-poll card (#3). Pre-reveal: tap an option to vote (the mark is
// optimistic; re-tap to change until reveal). Revealed: horizontal bars sized by
// each option's share, the correct answer flagged green, and this viewer's pick
// tagged. Styled to match the glass control chips.
export function PollCard({
  poll,
  hasName,
  myOptionIndex,
  reduceMotion,
  onVote,
  onNeedName,
}: {
  poll: ViewerPoll;
  hasName: boolean;
  myOptionIndex: number | null;
  reduceMotion: boolean;
  onVote: (optionIndex: number) => void;
  onNeedName: () => void;
}) {
  const revealed = poll.revealed;
  const tally = poll.tally ?? [];
  const total = poll.total ?? 0;
  const max = Math.max(1, ...(tally.length ? tally : [0]));
  // Branch vote (branch points): distinct badge/copy, the routed path is
  // highlighted instead of a "correct" answer, and a breadcrumb shows once the
  // presenter routes the room.
  const isBranch = poll.kind === "branch";
  const taken = isBranch && typeof poll.takenIndex === "number" ? poll.takenIndex : null;

  return (
    <div style={pollCardWrap} role="group" aria-label={isBranch ? "Branch vote" : "Live poll"}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <span style={pollBadge}>
          {isBranch ? (revealed ? "⑂ Path chosen" : "⑂ Choose our path") : revealed ? "Results" : "Live poll"}
        </span>
        {revealed ? (
          <span style={pollNote}>
            {total} vote{total === 1 ? "" : "s"}
          </span>
        ) : (
          myOptionIndex != null && <span style={pollNote}>Voted · waiting for results</span>
        )}
      </div>

      <div style={{ fontSize: 15, fontWeight: 500, color: "#262229", lineHeight: 1.4 }}>{poll.question}</div>

      {!revealed ? (
        !hasName ? (
          <button onClick={onNeedName} style={pollNameBtn}>
            Enter a name to vote
          </button>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {poll.options.map((opt, i) => {
              const mine = myOptionIndex === i;
              return (
                <button key={i} onClick={() => onVote(i)} aria-pressed={mine} style={pollOptionBtn(mine)}>
                  <span style={pollDot(mine)} aria-hidden />
                  <span style={{ flex: 1, minWidth: 0 }}>{opt}</span>
                </button>
              );
            })}
          </div>
        )
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {poll.options.map((opt, i) => {
            const count = tally[i] ?? 0;
            const correct = isBranch ? taken === i : poll.correctIndex === i;
            const mine = myOptionIndex === i;
            const pct = Math.round((count / max) * 100);
            return (
              <div key={i} style={pollResultRow}>
                <div
                  style={{
                    ...pollResultBar(correct, mine),
                    width: `${pct}%`,
                    transition: reduceMotion ? "none" : "width .45s ease",
                  }}
                  aria-hidden
                />
                <div style={pollResultText}>
                  <span style={{ flex: 1, display: "inline-flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{opt}</span>
                    {correct && <span style={pollTag("#3F7A12")}>{isBranch ? "⑂ taking this path" : "✓ correct"}</span>}
                    {mine && <span style={pollTag("#6E6A62")}>your pick</span>}
                  </span>
                  <span style={{ fontWeight: 600, color: "#3A372F", flex: "0 0 auto" }}>{count}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Branch breadcrumb — shows once the presenter routes the room. */}
      {isBranch && revealed && taken !== null && (
        <div style={pollWhy}>
          <span style={pollWhyLabel}>Path</span>⑂ {poll.options[taken]}
        </div>
      )}

      {/* "Why that answer" — the room-shared AI note attached after reveal. It
          arrives a session tick or two behind the tally, so it simply pops in. */}
      {revealed && poll.explanation && (
        <div style={pollWhy}>
          <span style={pollWhyLabel}>Why</span>
          {poll.explanation}
        </div>
      )}
    </div>
  );
}

const pollCardWrap: React.CSSProperties = {
  position: "absolute",
  left: 16,
  bottom: 16,
  zIndex: 38,
  width: "min(400px, calc(100% - 32px))",
  maxHeight: "min(70vh, 520px)",
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: "16px 18px",
  borderRadius: 18,
  background: "rgba(255,255,255,0.78)",
  border: "1px solid rgba(255,255,255,0.85)",
  backdropFilter: "blur(16px)",
  WebkitBackdropFilter: "blur(16px)",
  boxShadow: "0 22px 55px -28px rgba(60,55,45,0.6)",
  fontFamily: '"Outfit", system-ui, sans-serif',
};

export const pollBadge: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: "#4B5A16",
  background: "rgba(191,224,72,0.42)",
  padding: "3px 9px",
  borderRadius: 999,
};

const pollNote: React.CSSProperties = {
  fontSize: 11.5,
  fontWeight: 500,
  color: "#6E6A62",
  whiteSpace: "nowrap",
};

// The post-reveal "why that answer" note — green-tinted to pair with the ✓ tag.
const pollWhy: React.CSSProperties = {
  fontSize: 12.5,
  color: "#4A463E",
  lineHeight: 1.5,
  padding: "9px 11px",
  borderRadius: 11,
  background: "rgba(191,224,72,0.16)",
  border: "1px solid rgba(191,224,72,0.45)",
};

const pollWhyLabel: React.CSSProperties = {
  display: "block",
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: "#4B5A16",
  marginBottom: 3,
};

export const pollNameBtn: React.CSSProperties = {
  height: 40,
  borderRadius: 11,
  border: "none",
  cursor: "pointer",
  background: "#2C2A31",
  color: "#F4F2EC",
  fontFamily: "inherit",
  fontSize: 13.5,
  fontWeight: 500,
};

function pollOptionBtn(mine: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    textAlign: "left",
    padding: "11px 13px",
    borderRadius: 11,
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: 13.5,
    fontWeight: 500,
    color: mine ? "#F4F2EC" : "#2C2A31",
    background: mine ? "#2C2A31" : "rgba(255,255,255,0.62)",
    border: mine ? "1px solid #2C2A31" : "1px solid rgba(60,55,45,0.16)",
    transition: "background .15s ease, color .15s ease",
  };
}

function pollDot(mine: boolean): React.CSSProperties {
  return {
    width: 15,
    height: 15,
    borderRadius: "50%",
    flex: "0 0 auto",
    boxSizing: "border-box",
    border: mine ? "4px solid #BFE048" : "2px solid rgba(60,55,45,0.35)",
    background: mine ? "#2C2A31" : "transparent",
  };
}

export const pollResultRow: React.CSSProperties = {
  position: "relative",
  borderRadius: 11,
  overflow: "hidden",
  background: "rgba(60,55,45,0.07)",
  padding: "10px 12px",
};

export function pollResultBar(correct: boolean, mine: boolean): React.CSSProperties {
  return {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: 11,
    background: correct
      ? "rgba(120,176,54,0.34)"
      : mine
        ? "rgba(44,42,49,0.16)"
        : "rgba(120,116,108,0.16)",
  };
}

export const pollResultText: React.CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 13,
  fontWeight: 500,
  color: "#2C2A31",
};

export function pollTag(color: string): React.CSSProperties {
  return {
    fontSize: 9.5,
    fontWeight: 700,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    color,
    whiteSpace: "nowrap",
    flex: "0 0 auto",
  };
}
