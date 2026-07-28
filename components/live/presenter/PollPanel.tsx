"use client";

// The presenter's live poll / branch-vote panel (#3/#4) and its results view.
// Moved verbatim from PresenterConsole: compose state is local, the shell owns the
// live poll + tally and every /api/poll action.

import { useEffect, useRef, useState } from "react";
import { mapDraftError, winningIndex, type Poll, type SlideBranch } from "./shared";
import {
  FieldLabel,
  Label,
  btn,
  draftBtn,
  launchBtn,
  pollErrorText,
  pollExplain,
  pollIconBtn,
  pollPanelWrap,
  pollScroll,
  pollTextarea,
} from "./chrome";

// The poll panel (#3/#4). No live poll → the compose form (with the ✨ AI draft
// that FILLS it for review, never auto-launches). A live poll → results with a
// Reveal + Close. Compose state is local; the parent owns the live poll + tally.
export function PollPanel({
  poll,
  tally,
  total,
  slug,
  index,
  branches,
  reduceMotion,
  autoDraft,
  onAutoDraftDone,
  onLaunch,
  onOpenBranch,
  onRoute,
  onReveal,
  onClose,
  onDismiss,
}: {
  poll: Poll | null;
  tally: number[];
  total: number;
  slug: string;
  index: number;
  branches: SlideBranch[] | null; // the CURRENT slide's branch point, if any
  reduceMotion: boolean;
  autoDraft: boolean;
  onAutoDraftDone: () => void;
  onLaunch: (question: string, options: string[], correctIndex: number | null) => Promise<boolean>;
  onOpenBranch: () => Promise<boolean>;
  onRoute: (optionIndex: number) => Promise<boolean>;
  onReveal: () => void;
  onClose: () => void;
  onDismiss: () => void;
}) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [correctIndex, setCorrectIndex] = useState<number | null>(null);
  const [explanation, setExplanation] = useState<string | null>(null);
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [branchBusy, setBranchBusy] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);
  const draftCtrlRef = useRef<AbortController | null>(null);

  useEffect(() => () => draftCtrlRef.current?.abort(), []);

  async function openBranch() {
    if (branchBusy) return;
    setBranchBusy(true);
    setBranchError(null);
    const ok = await onOpenBranch();
    setBranchBusy(false);
    if (!ok) setBranchError("Couldn't open the branch vote — try again.");
  }

  // When a live poll closes, reset the compose form to a blank slate.
  const hadPollRef = useRef(false);
  useEffect(() => {
    if (poll) {
      hadPollRef.current = true;
      return;
    }
    if (hadPollRef.current) {
      hadPollRef.current = false;
      setQuestion("");
      setOptions(["", ""]);
      setCorrectIndex(null);
      setExplanation(null);
      setDraftError(null);
      setLaunchError(null);
    }
  }, [poll]);

  const setOptionAt = (i: number, val: string) => setOptions((o) => o.map((x, idx) => (idx === i ? val : x)));
  const addOption = () => setOptions((o) => (o.length >= 6 ? o : [...o, ""]));
  const removeOption = (i: number) => {
    setOptions((o) => (o.length <= 2 ? o : o.filter((_, idx) => idx !== i)));
    setCorrectIndex((c) => (c === null ? null : c === i ? null : c > i ? c - 1 : c));
  };
  const toggleCorrect = (i: number) => setCorrectIndex((c) => (c === i ? null : i));

  async function draft() {
    setDraftLoading(true);
    setDraftError(null);
    draftCtrlRef.current?.abort();
    const ctrl = new AbortController();
    draftCtrlRef.current = ctrl;
    try {
      const res = await fetch("/api/poll/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, index }),
        signal: ctrl.signal,
      });
      const data = (await res.json().catch(() => ({}))) as {
        question?: string;
        options?: string[];
        correctIndex?: number;
        explanation?: string;
        error?: string;
      };
      if (!res.ok) {
        setDraftError(mapDraftError(data.error));
        return;
      }
      const opts = Array.isArray(data.options) ? data.options.slice(0, 6) : [];
      setQuestion(data.question ?? "");
      setOptions(opts.length >= 2 ? opts : ["", ""]);
      setCorrectIndex(
        typeof data.correctIndex === "number" && data.correctIndex >= 0 && data.correctIndex < opts.length
          ? data.correctIndex
          : null,
      );
      setExplanation(data.explanation && data.explanation.trim() ? data.explanation : null);
      setLaunchError(null);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setDraftError("Couldn't draft — try again.");
    } finally {
      setDraftLoading(false);
    }
  }

  // "Launch check" (comprehension checkpoint): the parent opened this panel with a
  // pending auto-draft — run the SAME reviewed ✨ flow once, then consume the flag.
  // Deliberately keyed on `autoDraft` alone: it must fire exactly once per request,
  // not re-run as the draft's own state updates re-render the panel.
  useEffect(() => {
    if (!autoDraft) return;
    onAutoDraftDone();
    if (!poll) void draft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoDraft]);

  // Drop empty options and remap the correct index to the kept list, so the
  // backend's own empty-filtering can't shift which option is "correct".
  const kept: string[] = [];
  let mappedCorrect: number | null = null;
  options.forEach((o, i) => {
    const t = o.trim();
    if (!t) return;
    if (correctIndex === i) mappedCorrect = kept.length;
    kept.push(t);
  });
  const canLaunch = question.trim().length > 0 && kept.length >= 2 && !launching;

  async function launch() {
    if (!canLaunch) return;
    setLaunching(true);
    setLaunchError(null);
    const ok = await onLaunch(question.trim(), kept, mappedCorrect);
    setLaunching(false);
    if (!ok) setLaunchError("Couldn't launch — try again.");
  }

  return (
    <div style={pollPanelWrap}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Label>{poll ? (poll.kind === "branch" ? "Branch vote" : "Live poll") : "New poll"}</Label>
        <button onClick={onDismiss} title="Hide panel" aria-label="Hide poll panel" style={pollIconBtn}>
          ✕
        </button>
      </div>

      {poll ? (
        <PollResults poll={poll} tally={tally} total={total} reduceMotion={reduceMotion} onRoute={onRoute} onReveal={onReveal} onClose={onClose} />
      ) : (
        <div style={pollScroll}>
          {/* Branch point: this slide's authored paths — one tap opens the vote. */}
          {branches && (
            <div style={branchOffer}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: "#D6E88A" }}>
                ⑂ This slide is a branch point
              </div>
              {branches.map((b, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12, color: "#C9C5BC" }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.label}</span>
                  <span style={{ color: "#9A958A", whiteSpace: "nowrap" }}>
                    slides {b.from + 1}–{b.to + 1}
                  </span>
                </div>
              ))}
              <button onClick={() => void openBranch()} disabled={branchBusy} style={draftBtn(branchBusy)}>
                {branchBusy ? "Opening…" : "⑂ Open branch vote"}
              </button>
              {branchError && <div style={pollErrorText}>{branchError}</div>}
            </div>
          )}
          <button onClick={() => void draft()} disabled={draftLoading} style={draftBtn(draftLoading)}>
            {draftLoading ? "Drafting…" : "✨ Draft with AI"}
          </button>
          {draftError && <div style={pollErrorText}>{draftError}</div>}
          {explanation && <div style={pollExplain}>{explanation}</div>}

          <div>
            <FieldLabel>Question</FieldLabel>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Ask the room…"
              maxLength={400}
              rows={2}
              style={pollTextarea}
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <FieldLabel>Options · mark the correct one (optional)</FieldLabel>
            {options.map((opt, i) => {
              const removable = options.length > 2;
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => toggleCorrect(i)}
                    title={correctIndex === i ? "Correct answer — click to unset" : "Mark as the correct answer"}
                    aria-pressed={correctIndex === i}
                    aria-label={`Mark option ${i + 1} correct`}
                    style={correctDot(correctIndex === i)}
                  />
                  <input
                    value={opt}
                    onChange={(e) => setOptionAt(i, e.target.value)}
                    placeholder={`Option ${i + 1}`}
                    maxLength={200}
                    style={pollInput}
                  />
                  <button
                    type="button"
                    onClick={() => removeOption(i)}
                    disabled={!removable}
                    title="Remove option"
                    aria-label={`Remove option ${i + 1}`}
                    style={{ ...pollIconBtn, opacity: removable ? 1 : 0.35, cursor: removable ? "pointer" : "default" }}
                  >
                    –
                  </button>
                </div>
              );
            })}
            {options.length < 6 && (
              <button type="button" onClick={addOption} style={addOptionBtn}>
                + Add option
              </button>
            )}
          </div>

          {launchError && <div style={pollErrorText}>{launchError}</div>}
          <button onClick={() => void launch()} disabled={!canLaunch} style={launchBtn(canLaunch)}>
            {launching ? "Launching…" : "Launch poll"}
          </button>
        </div>
      )}
    </div>
  );
}

// Live/revealed results with bars (#3). Pre-reveal shows the presenter the running
// tally; after Reveal the correct option is highlighted (matching what viewers see).
// Branch votes: each option shows its slide range; after reveal one click routes
// the room to the winning branch (any path stays individually routable — untaken
// branches remain reachable), and the taken path is flagged.
function PollResults({
  poll,
  tally,
  total,
  reduceMotion,
  onRoute,
  onReveal,
  onClose,
}: {
  poll: Poll;
  tally: number[];
  total: number;
  reduceMotion: boolean;
  onRoute: (optionIndex: number) => Promise<boolean>;
  onReveal: () => void;
  onClose: () => void;
}) {
  const [routeBusy, setRouteBusy] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const max = Math.max(1, ...(tally.length ? tally : [0]));
  const isBranch = poll.kind === "branch";
  const taken = isBranch && typeof poll.takenIndex === "number" ? poll.takenIndex : null;
  const win = winningIndex(tally, poll.options.length);

  async function route(i: number) {
    if (routeBusy) return;
    setRouteBusy(true);
    setRouteError(null);
    const ok = await onRoute(i);
    setRouteBusy(false);
    if (!ok) setRouteError("Couldn't route — only the presenter with the clicker can move the room.");
  }

  return (
    <div style={pollScroll}>
      <div style={{ fontSize: 15, fontWeight: 500, color: "#F4F2EC", lineHeight: 1.4 }}>{poll.question}</div>
      <div style={{ fontSize: 12, fontWeight: 500, color: poll.revealed ? "#BFE048" : "#9A958A" }}>
        {poll.revealed ? "Revealed to the room" : isBranch ? "Live — the room is choosing a path" : "Live — collecting votes"} · {total} vote{total === 1 ? "" : "s"}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {poll.options.map((opt, i) => {
          const count = tally[i] ?? 0;
          const correct = isBranch ? taken === i : poll.correctIndex === i;
          const pct = Math.round((count / max) * 100);
          const share = total > 0 ? Math.round((count / total) * 100) : 0;
          const range = isBranch ? poll.branches?.[i] : undefined;
          return (
            <div key={i} style={presRow}>
              <div
                style={{
                  ...presBar(poll.revealed && correct),
                  width: `${pct}%`,
                  transition: reduceMotion ? "none" : "width .45s ease",
                }}
                aria-hidden
              />
              <div style={presText}>
                <span style={{ flex: 1, display: "inline-flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{opt}</span>
                  {range && (
                    <span style={{ fontSize: 10.5, color: "#9A958A", whiteSpace: "nowrap", flex: "0 0 auto" }}>
                      slides {range.from + 1}–{range.to + 1}
                    </span>
                  )}
                  {poll.revealed && (isBranch ? taken === i && <span style={presTag}>⑂ taken</span> : correct && <span style={presTag}>✓ correct</span>)}
                </span>
                <span style={{ fontWeight: 600, flex: "0 0 auto" }}>
                  {count}
                  {total > 0 ? ` · ${share}%` : ""}
                </span>
                {/* Untaken branches remain reachable — route to ANY path. */}
                {isBranch && poll.revealed && taken !== i && (
                  <button
                    onClick={() => void route(i)}
                    disabled={routeBusy}
                    title={`Take the room to slides ${(poll.branches?.[i]?.from ?? 0) + 1}–${(poll.branches?.[i]?.to ?? 0) + 1}`}
                    style={{ ...btn("rgba(255,255,255,0.12)", "#F4F2EC"), height: 26, padding: "0 10px", fontSize: 11.5, flex: "0 0 auto", opacity: routeBusy ? 0.6 : 1 }}
                  >
                    Go →
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {/* "Why that answer" — the room-shared note viewers see under the frozen
          tally (arrives on the poll tick shortly after reveal). Same style as
          the draft rationale in the compose form. */}
      {poll.revealed && poll.explanation && <div style={pollExplain}>{poll.explanation}</div>}
      {isBranch && poll.revealed && taken !== null && (
        <div style={pollExplain}>
          ⑂ Routed the room to <strong style={{ fontWeight: 600 }}>{poll.options[taken]}</strong>
          {poll.branches?.[taken] ? ` (slides ${poll.branches[taken].from + 1}–${poll.branches[taken].to + 1})` : ""}.
          Untaken paths stay reachable — Go → any of them, or navigate freely.
        </div>
      )}
      {routeError && <div style={pollErrorText}>{routeError}</div>}
      <div style={{ display: "flex", gap: 10, marginTop: 2 }}>
        {!poll.revealed && (
          <button onClick={onReveal} style={{ ...btn("#BFE048", "#1B1B20"), flex: 1, height: 40, fontWeight: 600 }}>
            {isBranch ? "Reveal the room's choice" : "Reveal to room"}
          </button>
        )}
        {isBranch && poll.revealed && taken === null && (
          <button
            onClick={() => void route(win)}
            disabled={routeBusy}
            style={{ ...btn("#BFE048", "#1B1B20"), flex: 1, height: 40, fontWeight: 600, opacity: routeBusy ? 0.7 : 1 }}
          >
            {routeBusy ? "Routing…" : `⑂ Go to winning branch — ${poll.options[win] ?? ""}`}
          </button>
        )}
        <button onClick={onClose} style={{ ...btn("rgba(255,255,255,0.1)", "#F4F2EC"), flex: poll.revealed && !(isBranch && taken === null) ? 1 : "0 0 auto", height: 40 }}>
          Close
        </button>
      </div>
    </div>
  );
}

const pollInput: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 36,
  padding: "0 11px",
  borderRadius: 9,
  border: "1px solid rgba(255,255,255,0.16)",
  background: "rgba(255,255,255,0.06)",
  color: "#F4F2EC",
  fontFamily: "inherit",
  fontSize: 13,
  outline: "none",
};

function correctDot(on: boolean): React.CSSProperties {
  return {
    width: 20,
    height: 20,
    flex: "0 0 auto",
    borderRadius: "50%",
    cursor: "pointer",
    boxSizing: "border-box",
    padding: 0,
    border: on ? "6px solid #BFE048" : "2px solid rgba(255,255,255,0.3)",
    background: on ? "#1B1B20" : "transparent",
  };
}

const addOptionBtn: React.CSSProperties = {
  height: 34,
  borderRadius: 9,
  border: "1px dashed rgba(255,255,255,0.22)",
  background: "transparent",
  color: "#C9C5BC",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 12.5,
  fontWeight: 500,
};

// The branch-point offer in the compose panel (this slide's authored paths).
const branchOffer: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: "10px 12px",
  borderRadius: 10,
  background: "rgba(191,224,72,0.08)",
  border: "1px solid rgba(191,224,72,0.3)",
};

const presRow: React.CSSProperties = {
  position: "relative",
  borderRadius: 9,
  overflow: "hidden",
  background: "rgba(255,255,255,0.05)",
  padding: "9px 11px",
};

function presBar(correct: boolean): React.CSSProperties {
  return {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: 9,
    background: correct ? "rgba(191,224,72,0.32)" : "rgba(255,255,255,0.1)",
  };
}

const presText: React.CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 13,
  color: "#F4F2EC",
};

const presTag: React.CSSProperties = {
  fontSize: 9.5,
  fontWeight: 700,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  color: "#BFE048",
  whiteSpace: "nowrap",
  flex: "0 0 auto",
};
