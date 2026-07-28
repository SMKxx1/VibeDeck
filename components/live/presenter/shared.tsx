// Presenter-side pieces shared by BOTH presenter surfaces — PresenterConsole (the
// dark embed-deck console) and UploadedDeckFrame's presenter half (the light-glass
// uploaded-deck controls). Everything here was byte-identical in the two files and
// is moved verbatim; PresenterConsole is the source of truth.
//
// NOT here on purpose: the panels themselves and their styling. UploadedDeckFrame's
// presenter panels are deliberate light-glass adaptations of these dark ones, so
// every themed const (FieldLabel, correctDot, draftBtn, qnaRow, checkBtn, …) stays
// forked in each file.

import type { SignalKind } from "@/components/live/types";

export interface Signal {
  name: string;
  kind: SignalKind;
  at: number;
}
export interface Viewer {
  name: string;
  index: number;
  follow: boolean;
}

// What the presenter queues to follow a Turn & Talk (see each host's Activity).
export type ActivityFollowUp = "poll" | "pinboard";

// A branch-point path (lib/types.ts SlideBranch) — 0-based inclusive range.
export interface SlideBranch {
  label: string;
  from: number;
  to: number;
}

// The full poll record (#3) — the presenter sees the correct answer + the live
// tally, unlike the viewer-safe projection delivered on /api/session.
export interface Poll {
  id: string;
  kind?: "poll" | "branch"; // absent = regular poll
  question: string;
  options: string[];
  correctIndex: number | null;
  revealed: boolean;
  tally: number[] | null;
  total: number | null;
  explanation?: string; // "why that answer" — attached after reveal
  branches?: SlideBranch[]; // kind "branch": option i routes to branches[i]
  takenIndex?: number; // kind "branch": the routed option (post-reveal)
  at: number;
}

// Per-question drafted-answer state (#5). Local to the panel so it resets when the
// panel is closed (matching the poll compose form).
export interface AiAnswerState {
  loading: boolean;
  open: boolean;
  answer?: string;
  error?: string;
}

// The tally's winning option (first wins a tie) — the branch the room chose.
export function winningIndex(tally: number[], optionCount: number): number {
  let win = 0;
  for (let i = 1; i < optionCount; i++) {
    if ((tally[i] ?? 0) > (tally[win] ?? 0)) win = i;
  }
  return win;
}

export function mapRecapError(code?: string): string {
  switch (code) {
    case "ai_budget_exceeded":
      return "AI is at today's usage limit.";
    case "rate_limited":
      return "Slow down a moment.";
    case "no_content":
      return "This slide has no text to recap.";
    case "ai_not_configured":
      return "AI isn't configured.";
    default:
      return "Couldn't send — try again.";
  }
}

export function mapDraftError(code?: string): string {
  switch (code) {
    case "ai_budget_exceeded":
      return "AI is at today's usage limit.";
    case "rate_limited":
      return "Slow down a moment.";
    case "no_content":
      return "This slide has no text to quiz on.";
    case "ai_not_configured":
      return "AI isn't configured.";
    default:
      return "Couldn't draft — try again.";
  }
}

export function mapAskError(code?: string): string {
  switch (code) {
    case "ai_budget_exceeded":
      return "AI is at today's usage limit.";
    case "rate_limited":
      return "Slow down a moment.";
    case "unknown_deck":
      return "This deck isn't available.";
    default:
      return "Couldn't draft an answer — try again.";
  }
}

export function floatStyle(left: number): React.CSSProperties {
  return {
    position: "absolute",
    bottom: 20,
    left: `${left}%`,
    fontSize: 30,
    lineHeight: 1,
    animation: "vibedeck-rise 2s ease-out forwards",
    willChange: "transform, opacity",
    userSelect: "none",
  };
}

export function qnaStateTag(color: string): React.CSSProperties {
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

// Turn & Talk duration presets — synchronized countdowns, so no free-form input.
export const ACTIVITY_PRESETS: { label: string; sec: number }[] = [
  { label: "2 min", sec: 120 },
  { label: "5 min", sec: 300 },
  { label: "10 min", sec: 600 },
];
