"use client";

// Shared viewer Q&A queue panel (#5) + its style helpers — the SINGLE
// implementation used by both LiveDeck and UploadedDeckFrame. Extracted verbatim
// from LiveDeck, which remains the source of truth.
//
// `qnaCloseBtn` / `qnaErrorText` are also reused by UploadedDeckFrame's presenter
// panels, so they are exported alongside the panel.

import { useState } from "react";
import type { QnaQuestion } from "./types";
import { pollBadge, pollNameBtn } from "./PollCard";

// The viewer's Q&A queue panel (#5). Read the room's questions (already sorted
// top-voted first), upvote with one tap (locks locally; the server is idempotent),
// and post your own. Anchored to the right so it clears the bottom-left poll card.
// Owns only its input state — the queue + vote marks live in the parent so they
// persist across open/close.
export function QnaPanel({
  questions,
  hasName,
  myVotes,
  onUpvote,
  onAsk,
  onNeedName,
  onClose,
}: {
  questions: QnaQuestion[];
  hasName: boolean;
  myVotes: Record<string, boolean>;
  onUpvote: (qid: string) => void;
  onAsk: (text: string) => Promise<string | null>;
  onNeedName: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const t = text.trim();
    if (!t || asking) return;
    setAsking(true);
    setError(null);
    const err = await onAsk(t);
    setAsking(false);
    if (err) setError(err);
    else setText("");
  };

  return (
    <div style={qnaCardWrap} role="group" aria-label="Question queue">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <span style={pollBadge}>Questions</span>
        <button onClick={onClose} title="Hide questions" aria-label="Hide questions" style={qnaCloseBtn}>
          ✕
        </button>
      </div>

      <div style={qnaList}>
        {questions.length === 0 ? (
          <div style={qnaEmpty}>No questions yet — be the first to ask.</div>
        ) : (
          questions.map((q) => {
            const voted = !!myVotes[q.id];
            return (
              <div key={q.id} style={qnaItem}>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13.5, color: "#2C2A31", lineHeight: 1.4 }}>{q.text}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11.5, color: "#6E6A62", minWidth: 0 }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 150 }}>{q.name}</span>
                    {q.answered && <span style={qnaAnsweredTag}>✓ answered</span>}
                  </div>
                </div>
                <button
                  onClick={() => (hasName ? onUpvote(q.id) : onNeedName())}
                  disabled={voted}
                  aria-pressed={voted}
                  title={voted ? "You upvoted this" : "Upvote this question"}
                  style={qnaVoteBtn(voted)}
                >
                  👍 {q.votes}
                </button>
              </div>
            );
          })
        )}
      </div>

      {hasName ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {error && <div style={qnaErrorText}>{error}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder="Ask a question…"
              maxLength={280}
              style={qnaInput}
            />
            <button onClick={() => void submit()} disabled={!text.trim() || asking} style={qnaAskBtn(!!text.trim() && !asking)}>
              {asking ? "…" : "Ask"}
            </button>
          </div>
        </div>
      ) : (
        <button onClick={onNeedName} style={pollNameBtn}>
          Enter a name to ask
        </button>
      )}
    </div>
  );
}

const qnaCardWrap: React.CSSProperties = {
  position: "absolute",
  right: 16,
  top: 60,
  bottom: 16,
  zIndex: 38,
  width: "min(360px, calc(100% - 32px))",
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: 16,
  borderRadius: 18,
  background: "rgba(255,255,255,0.82)",
  border: "1px solid rgba(255,255,255,0.85)",
  backdropFilter: "blur(16px)",
  WebkitBackdropFilter: "blur(16px)",
  boxShadow: "0 22px 55px -28px rgba(60,55,45,0.6)",
  fontFamily: '"Outfit", system-ui, sans-serif',
};

const qnaList: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const qnaItem: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
  padding: "10px 11px",
  borderRadius: 12,
  background: "rgba(255,255,255,0.6)",
  border: "1px solid rgba(60,55,45,0.1)",
};

const qnaEmpty: React.CSSProperties = {
  fontSize: 12.5,
  color: "#6E6A62",
  padding: "10px 2px",
};

const qnaAnsweredTag: React.CSSProperties = {
  fontSize: 9.5,
  fontWeight: 700,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  color: "#3F7A12",
  whiteSpace: "nowrap",
  flex: "0 0 auto",
};

function qnaVoteBtn(voted: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    flex: "0 0 auto",
    height: 30,
    padding: "0 11px",
    borderRadius: 999,
    cursor: voted ? "default" : "pointer",
    fontFamily: "inherit",
    fontSize: 12.5,
    fontWeight: 600,
    color: voted ? "#F4F2EC" : "#2C2A31",
    background: voted ? "#2C2A31" : "rgba(255,255,255,0.7)",
    border: voted ? "1px solid #2C2A31" : "1px solid rgba(60,55,45,0.18)",
    transition: "background .15s ease, color .15s ease",
  };
}

const qnaInput: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 40,
  padding: "0 13px",
  borderRadius: 11,
  border: "1px solid rgba(60,55,45,0.18)",
  background: "rgba(255,255,255,0.85)",
  fontFamily: "inherit",
  fontSize: 13.5,
  color: "#2C2A31",
  outline: "none",
};

function qnaAskBtn(enabled: boolean): React.CSSProperties {
  return {
    flex: "0 0 auto",
    height: 40,
    padding: "0 16px",
    borderRadius: 11,
    border: "none",
    cursor: enabled ? "pointer" : "default",
    background: enabled ? "#2C2A31" : "#B7B2A8",
    color: "#F4F2EC",
    fontFamily: "inherit",
    fontSize: 13.5,
    fontWeight: 500,
  };
}

export const qnaErrorText: React.CSSProperties = {
  fontSize: 12,
  color: "#B5331F",
  fontWeight: 500,
};

export const qnaCloseBtn: React.CSSProperties = {
  width: 28,
  height: 28,
  flex: "0 0 auto",
  borderRadius: 8,
  border: "1px solid rgba(60,55,45,0.16)",
  background: "rgba(255,255,255,0.6)",
  color: "#6E6A62",
  cursor: "pointer",
  fontSize: 13,
  lineHeight: 1,
  padding: 0,
};
