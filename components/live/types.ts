// Shared live-room types + constants — the SINGLE implementation used by both
// LiveDeck (embed decks) and UploadedDeckFrame (uploaded decks). Extracted
// verbatim from LiveDeck, which remains the source of truth for this module.
//
// NOT here (they genuinely differ between the two hosts, so each keeps its own):
//   • DeckState — LiveDeck's carries nextLabel/notes; the uploaded-deck bridge
//     only reports index/total/label.
//   • mapCatchUpError — LiveDeck handles an extra "password_required" code.

export const POLL_MS = Number(process.env.NEXT_PUBLIC_SESSION_POLL_MS) || 2000;
// Back off when there's nothing to sync so an idle or backgrounded tab doesn't
// hammer Redis. The live experience is unchanged — these only apply when no
// presenter is live (viewer) or the tab is hidden.
export const IDLE_POLL_MS = 10_000; // viewer, no presenter live
export const HIDDEN_POLL_MS = 60_000; // tab in the background
export const PRESENTER_POLL_MS = 5_000; // presenter: this poll is only a cross-device fallback
export const NAME_KEY = "presentation:name";

// Q&A queue (#5): the viewer panel polls only while it's open, so a closed panel
// costs nothing. Slower cadence than the live session poll; near-dormant when hidden.
export const QNA_POLL_MS = 5_000;
export const QNA_HIDDEN_MS = 30_000;

// Viewer→presenter backchannel reaction kinds (#2). "lost" is rendered as its
// own distinct button; the rest ride in a compact icon row.
export type SignalKind = "up" | "party" | "slow" | "hand" | "lost";
export const REACTIONS: { kind: SignalKind; emoji: string; label: string }[] = [
  { kind: "up", emoji: "👍", label: "Nice" },
  { kind: "party", emoji: "🎉", label: "Celebrate" },
  { kind: "slow", emoji: "🐢", label: "Slow down" },
  { kind: "hand", emoji: "🙋", label: "Raise hand" },
];

// The client-side role of whoever is looking at the deck. Named ViewerRole (not
// Role) because lib/users.ts owns the server-side Role.
export type ViewerRole = "viewer" | "presenter";

export interface SessionState {
  index: number;
  max: number;
  // A presenter is actively presenting. When false, viewers browse freely
  // (no lock, no auto-follow); the sync only kicks in while someone's live.
  live: boolean;
  // Co-host mode (presenter only): false when ANOTHER presenter holds the clicker
  // (slide control). Absent/true — including an unclaimed session — means drive.
  isDriver?: boolean;
}

// The viewer-safe projection of a live poll (#3), delivered on the SAME session
// poll. Pre-reveal: correctIndex/tally/total are null — viewers never see the
// answer or counts until the presenter reveals. `explanation` is the AI "why that
// answer" note, generated once per poll and attached shortly AFTER reveal (it
// arrives on a later session tick — the card just re-renders when it lands).
export interface ViewerPoll {
  id: string;
  // "branch" = a branch-point vote: the options are paths through the deck and
  // the presenter routes the room to the winner (takenIndex = the breadcrumb).
  kind?: "poll" | "branch";
  question: string;
  options: string[];
  revealed: boolean;
  correctIndex: number | null;
  tally: number[] | null;
  total: number | null;
  explanation: string | null;
  takenIndex?: number | null;
  at: number;
}

// A presenter-broadcast recap of a slide (comprehension checkpoint), delivered on
// the same session poll. Dismiss is local per viewer; a new id shows again.
export interface Recap {
  id: string;
  text: string;
  slideIndex: number;
  at: number;
}

// A presenter-broadcast Turn & Talk activity: a discussion/exercise prompt + a
// synchronized countdown, delivered on the same session poll. Viewers count down
// CLIENT-SIDE from `endsAt` (no per-second server traffic); "Regroup" clears it
// everywhere at once. Hide is local per viewer; a new id shows the card again.
export interface Activity {
  id: string;
  prompt: string;
  endsAt: number; // epoch ms
  followUp: "poll" | "pinboard" | null;
  at: number;
}

// This viewer's personal "catch me up" recap: an on-demand AI summary of the
// slides between THEIR slide and the live slide. Local to the tab — never
// broadcast — so it lives here, not on the session poll.
export interface CatchUp {
  from: number; // the viewer's slide (0-based) when they asked
  to: number; // the live slide at that moment
  text: string | null; // null until loaded
  error: string | null;
  loading: boolean;
}

// A question in the upvotable Q&A queue (#5). Viewers receive only non-dismissed
// entries, already sorted (votes desc, oldest-first).
export interface QnaQuestion {
  id: string;
  name: string;
  text: string;
  votes: number;
  answered: boolean;
  dismissed: boolean;
  at: number;
}
