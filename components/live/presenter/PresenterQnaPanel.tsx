"use client";

// The presenter's Q&A queue panel (#5) — digest, queue, answer/dismiss and the
// one-tap AI answer. Moved verbatim from PresenterConsole (named PresenterQnaPanel
// so it doesn't collide with the VIEWER panel exported from components/live/QnaPanel).

import { useEffect, useRef, useState } from "react";
import { mapAskError, qnaStateTag, type AiAnswerState } from "./shared";
import { Label, draftBtn, pollErrorText, pollIconBtn, pollPanelWrap, pollScroll } from "./chrome";

// A question in the upvotable Q&A queue (#5). The presenter's GET is cookie-authed,
// so it also includes dismissed entries (viewers never see those).
export interface QnaQuestion {
  id: string;
  name: string;
  text: string;
  votes: number;
  answered: boolean;
  dismissed: boolean;
  at: number;
}

// The presenter's Q&A panel (#5): a top-of-panel AI confusion digest, then the full
// queue (top-voted first; dismissed ones greyed but still listed). Per question:
// Answer, Dismiss/Restore, and a one-tap ✨ AI answer drafted from the current slide
// (collapsible so the presenter can verify before speaking). AI/digest state is local
// — the parent owns the queue and applies each action's returned list.
export function PresenterQnaPanel({
  questions,
  slug,
  index,
  onAction,
  onDismiss,
}: {
  questions: QnaQuestion[];
  slug: string;
  index: number;
  onAction: (action: "answer" | "dismiss" | "undismiss", qid: string) => void;
  onDismiss: () => void;
}) {
  const [ai, setAi] = useState<Record<string, AiAnswerState>>({});
  const [themes, setThemes] = useState<string[] | null>(null);
  const [digestLoading, setDigestLoading] = useState(false);
  const [digestError, setDigestError] = useState<string | null>(null);
  const aiCtrlsRef = useRef<Record<string, AbortController>>({});
  const digestCtrlRef = useRef<AbortController | null>(null);
  const indexRef = useRef(index);
  indexRef.current = index;

  // Abort any in-flight AI/digest requests when the panel closes/unmounts.
  useEffect(
    () => () => {
      Object.values(aiCtrlsRef.current).forEach((c) => c.abort());
      digestCtrlRef.current?.abort();
    },
    [],
  );

  // Draft an answer for one question via /api/ask (non-stream). A prior draft for the
  // SAME question is aborted; concurrent drafts across questions are allowed.
  async function aiAnswer(qid: string, questionText: string) {
    aiCtrlsRef.current[qid]?.abort();
    const ctrl = new AbortController();
    aiCtrlsRef.current[qid] = ctrl;
    setAi((m) => ({ ...m, [qid]: { loading: true, open: true } }));
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug,
          name: "presenter",
          question: questionText,
          slideIndex: indexRef.current,
          stream: false,
        }),
        signal: ctrl.signal,
      });
      const data = (await res.json().catch(() => ({}))) as { answer?: string; error?: string };
      if (!res.ok) {
        setAi((m) => ({ ...m, [qid]: { loading: false, open: true, error: mapAskError(data.error) } }));
        return;
      }
      const answer = (data.answer ?? "").trim() || "No answer was generated.";
      setAi((m) => ({ ...m, [qid]: { loading: false, open: true, answer } }));
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setAi((m) => ({ ...m, [qid]: { loading: false, open: true, error: "Couldn't draft an answer — try again." } }));
    } finally {
      if (aiCtrlsRef.current[qid] === ctrl) delete aiCtrlsRef.current[qid];
    }
  }

  const toggleAi = (qid: string) =>
    setAi((m) => (m[qid] ? { ...m, [qid]: { ...m[qid], open: !m[qid].open } } : m));

  // AI confusion digest — /api/qna/digest never errors, so [] just means "not enough".
  async function runDigest() {
    setDigestLoading(true);
    setDigestError(null);
    digestCtrlRef.current?.abort();
    const ctrl = new AbortController();
    digestCtrlRef.current = ctrl;
    try {
      const res = await fetch("/api/qna/digest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
        signal: ctrl.signal,
      });
      const data = (await res.json().catch(() => ({}))) as { themes?: string[] };
      setThemes(Array.isArray(data.themes) ? data.themes.slice(0, 3) : []);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setDigestError("Couldn't summarize — try again.");
    } finally {
      setDigestLoading(false);
    }
  }

  return (
    <div style={pollPanelWrap}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Label>Questions</Label>
        <button onClick={onDismiss} title="Hide panel" aria-label="Hide questions panel" style={pollIconBtn}>
          ✕
        </button>
      </div>

      {/* AI confusion digest */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <button onClick={() => void runDigest()} disabled={digestLoading} style={draftBtn(digestLoading)}>
          {digestLoading ? "Summarizing…" : "✨ Summarize confusion"}
        </button>
        {digestError && <div style={pollErrorText}>{digestError}</div>}
        {themes &&
          (themes.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 11.5, color: "#9A958A" }}>The room is stuck on:</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {themes.map((t, i) => (
                  <span key={i} style={digestChip}>
                    {t}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "#7A7770" }}>Not enough questions yet.</div>
          ))}
      </div>

      {/* the queue */}
      <div style={pollScroll}>
        {questions.length === 0 ? (
          <div style={{ fontSize: 13, color: "#7A7770" }}>No questions from the room yet.</div>
        ) : (
          questions.map((q) => {
            const a = ai[q.id];
            const hasDraft = !!(a && (a.answer || a.error));
            return (
              <div key={q.id} style={qnaRow(q.dismissed)}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                  <div style={qnaVotes}>
                    <span style={{ fontSize: 15, fontWeight: 700, lineHeight: 1 }}>{q.votes}</span>
                    <span style={{ fontSize: 8.5, color: "#9A958A", textTransform: "uppercase", letterSpacing: "0.06em" }}>votes</span>
                  </div>
                  <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 5 }}>
                    <div style={{ fontSize: 13.5, color: q.dismissed ? "#9A958A" : "#F4F2EC", lineHeight: 1.4 }}>{q.text}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, color: "#9A958A", flexWrap: "wrap", minWidth: 0 }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 130 }}>{q.name}</span>
                      {q.answered && <span style={qnaStateTag("#BFE048")}>✓ answered</span>}
                      {q.dismissed && <span style={qnaStateTag("#9A958A")}>dismissed</span>}
                    </div>

                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 2 }}>
                      {!q.dismissed && (
                        <button
                          onClick={() => onAction("answer", q.id)}
                          style={qnaActionBtn}
                          title={q.answered ? "Already answered — click to re-mark" : "Mark as answered"}
                        >
                          {q.answered ? "✓ Answered" : "✓ Answer"}
                        </button>
                      )}
                      {q.dismissed ? (
                        <button onClick={() => onAction("undismiss", q.id)} style={qnaActionBtn} title="Restore to the queue">
                          ↩ Restore
                        </button>
                      ) : (
                        <button onClick={() => onAction("dismiss", q.id)} style={qnaActionBtn} title="Dismiss from the queue">
                          Dismiss
                        </button>
                      )}
                      <button
                        onClick={() => {
                          if (hasDraft) toggleAi(q.id);
                          else void aiAnswer(q.id, q.text);
                        }}
                        disabled={a?.loading}
                        style={qnaAiBtn(!!a?.loading)}
                        title="Draft an answer with AI from the current slide"
                      >
                        {a?.loading ? "✨ Drafting…" : hasDraft ? (a?.open ? "Hide AI answer" : "Show AI answer") : "✨ AI answer"}
                      </button>
                      {hasDraft && !a?.loading && (
                        <button onClick={() => void aiAnswer(q.id, q.text)} style={qnaActionBtn} title="Redraft with AI">
                          ↻
                        </button>
                      )}
                    </div>

                    {a && a.open && (a.loading || a.answer || a.error) && (
                      <div style={qnaAiBlock}>
                        {a.loading ? (
                          <span style={{ color: "#9A958A", fontSize: 12.5 }}>Drafting an answer…</span>
                        ) : a.error ? (
                          <span style={pollErrorText}>{a.error}</span>
                        ) : (
                          <div style={{ fontSize: 12.5, lineHeight: 1.55, color: "#E7E4DC", whiteSpace: "pre-wrap" }}>{a.answer}</div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

const digestChip: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#D6E88A",
  background: "rgba(191,224,72,0.14)",
  border: "1px solid rgba(191,224,72,0.4)",
  borderRadius: 999,
  padding: "5px 11px",
  lineHeight: 1.35,
};

function qnaRow(dismissed: boolean): React.CSSProperties {
  return {
    borderRadius: 10,
    padding: "10px 11px",
    background: dismissed ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.05)",
    border: "1px solid rgba(255,255,255,0.1)",
    opacity: dismissed ? 0.6 : 1,
  };
}

const qnaVotes: React.CSSProperties = {
  flex: "0 0 auto",
  width: 40,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 2,
  padding: "5px 0",
  borderRadius: 8,
  background: "rgba(255,255,255,0.06)",
};

const qnaActionBtn: React.CSSProperties = {
  height: 28,
  padding: "0 10px",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.16)",
  background: "rgba(255,255,255,0.06)",
  color: "#E7E4DC",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 12,
  fontWeight: 500,
};

function qnaAiBtn(loading: boolean): React.CSSProperties {
  return {
    height: 28,
    padding: "0 10px",
    borderRadius: 8,
    border: "1px solid rgba(191,224,72,0.4)",
    background: "rgba(191,224,72,0.14)",
    color: "#D6E88A",
    cursor: loading ? "default" : "pointer",
    fontFamily: "inherit",
    fontSize: 12,
    fontWeight: 600,
    opacity: loading ? 0.75 : 1,
  };
}

const qnaAiBlock: React.CSSProperties = {
  marginTop: 4,
  padding: "9px 11px",
  borderRadius: 8,
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.1)",
};
