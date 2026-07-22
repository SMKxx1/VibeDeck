"use client";

// Full-bleed live viewer for an uploaded deck's OWN self-contained HTML, served
// from the isolated DECK_ORIGIN and framed here under a hard sandbox.
//
// This is NOT LiveDeck. LiveDeck wraps the one trusted first-party workshop deck.
// Uploaded HTML is UNTRUSTED stored content — so it gets the SAME multi-user live
// experience (presenter drives, viewers follow, reactions/polls/Q&A) but through a
// deliberately narrow, navigation-only bridge that never trusts the framed content
// and never hands it anything worth stealing.
//
// Why this stays safe for untrusted content — the trust model differs from LiveDeck
// on two load-bearing axes:
//
//   1. IDENTITY, not origin. A sandboxed frame with NO `allow-same-origin` runs in
//      an opaque origin, so `event.origin` is the literal string "null" — useless
//      (and checking it would reject every real message). The real authenticator is
//      `event.source === iframeRef.current.contentWindow`: the message
//      object-identity of OUR frame's window, which untrusted code elsewhere on the
//      page cannot forge. We accept a message ONLY when that holds AND it carries
//      the `source:"deck"` marker; everything else is dropped. (LiveDeck trusts the
//      `source:"deck"` marker alone — fine for a first-party deck, too weak here.)
//
//   2. SEND is NAVIGATION-ONLY, through ONE choke point. Everything we post to the
//      frame goes through `sendToDeck`, whose argument type is a closed union of
//      exactly four whitelisted, non-sensitive navigation messages:
//        • { type:"deck:goto", index }      — sync the frame to a slide number
//        • { type:"deck:role", role, max?, locked? } — set follow/clamp enforcement
//        • { type:"deck:advance", dir }      — step the deck (unused here, whitelisted)
//        • { type:"deck:report" }            — ask the deck to re-emit its slide
//      targetOrigin MUST be "*" (an opaque-origin frame has no specific origin to
//      target). Rationale: a sandboxed deck can navigate ITSELF to an attacker
//      origin, and a "*" send would then reach WHEREVER it went — so we send ONLY
//      navigation ints/enums (a slide index or a role), which are meaningless to
//      leak. We NEVER post pins, viewer names, session tokens, poll/Q&A payloads,
//      or ANY secret to the frame — exactly the pin/session data Phase 2
//      deliberately withheld. ALL /api/* traffic happens in THIS React parent
//      (the deck's own CSP is `connect-src 'none'`; it makes no network requests).
//
// Sandbox rationale (each omission is load-bearing, not an oversight):
//   sandbox="allow-scripts"  — the deck runs its own JS engine + bridge, but with
//     NO `allow-same-origin`, so even though it's served from DECK_ORIGIN the frame
//     is forced into an opaque, origin-of-its-own context: it can't read cookies,
//     localStorage, or the DOM of THIS parent, and same-origin fetches from inside
//     it are treated cross-origin. This is the primary containment — do NOT add
//     allow-same-origin.
//   (no allow-top-navigation)   — untrusted content can't hijack the top frame.
//   (no allow-same-origin)      — see above; the whole point of the isolation.
//   allow="fullscreen"          — the only capability an artifact deck legitimately
//     needs; a Permissions-Policy grant, orthogonal to the sandbox trust bits.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Deck } from "@/lib/types";
import { LiveChat } from "./LiveChat";
import { useFullscreen } from "@/lib/useFullscreen";
import { PulseHeatStrip, InsightPanel, type PulseSlideDto } from "@/components/InsightPulse";

// Reuse the workshop's stored viewer name so a returning visitor keeps their name
// across decks. Where a name is REQUIRED (vote / ask / presence heartbeat) we gate
// exactly like LiveDeck — but watching itself never requires a name.
const NAME_KEY = "presentation:name";

// Viewer session cadence (mirrors LiveDeck): snappy while a presenter is live,
// lazy when idle, near-dormant when the tab is hidden.
const POLL_MS = Number(process.env.NEXT_PUBLIC_SESSION_POLL_MS) || 2000;
const IDLE_POLL_MS = 10_000; // viewer, no presenter live
const HIDDEN_POLL_MS = 60_000; // tab in the background
const PRESENTER_POLL_MS = 5_000; // presenter: session read is a display-only fallback

// Viewer Q&A panel poll — runs only while the panel is open (mirrors LiveDeck).
const QNA_POLL_MS = 5_000;
const QNA_HIDDEN_MS = 30_000;

// Presenter live-room tick (roster + reactions + poll + Q&A on ONE ~4s timer, with
// hidden-tab backoff — mirrors PresenterConsole).
const PRESENCE_POLL_MS = 4_000;
const PRESENCE_HIDDEN_MS = 30_000;

// Comprehension checkpoint: when this many DISTINCT viewers hit "I'm lost" inside
// the meter's 15s window (see /api/signal GET), surface the one-tap fixes. The
// meter decays fast, so it inherently reflects the slide being shown right now.
const LOST_THRESHOLD = 3;

type Role = "presenter" | "viewer";

// Viewer→presenter backchannel reaction kinds (#2). "lost" is its own button; the
// rest ride in a compact icon row.
type SignalKind = "up" | "party" | "slow" | "hand" | "lost";
const REACTIONS: { kind: SignalKind; emoji: string; label: string }[] = [
  { kind: "up", emoji: "👍", label: "Nice" },
  { kind: "party", emoji: "🎉", label: "Celebrate" },
  { kind: "slow", emoji: "🐢", label: "Slow down" },
  { kind: "hand", emoji: "🙋", label: "Raise hand" },
];
// Only these float over the presenter's slide; slow/lost drive the help meter.
const ANIMATE_KINDS = new Set<SignalKind>(["up", "party", "hand"]);
const REACTION_EMOJI: Record<string, string> = { up: "👍", party: "🎉", hand: "🙋" };
const FLOAT_KEYFRAMES =
  "@keyframes vibedeck-rise{0%{transform:translateY(0) scale(0.7);opacity:0}15%{opacity:1}100%{transform:translateY(-150px) scale(1.15);opacity:0}}";

// SECURITY: the closed set of messages `sendToDeck` may post to the untrusted
// frame. The union itself is the whitelist — the compiler rejects anything that
// isn't one of these navigation-only shapes, so there is no code path that can post
// a pin, name, token, or poll/Q&A payload to the deck. See header comment §2.
type DeckControlMessage =
  | { type: "deck:goto"; index: number }
  | { type: "deck:role"; role: Role; max?: number; locked?: boolean }
  | { type: "deck:advance"; dir: number }
  | { type: "deck:report" };

// ── receive-only slide state (what the deck reports over `slidechange`) ──
interface DeckState {
  index: number;
  total: number;
  label: string;
}
interface SessionState {
  index: number;
  max: number;
  // A presenter is actively presenting. When false, viewers browse freely.
  live: boolean;
  // Co-host mode (presenter only): false when ANOTHER presenter holds the clicker
  // (slide control). Absent/true — including an unclaimed session — means drive.
  isDriver?: boolean;
}

// Viewer-safe poll projection, delivered on the SAME /api/session read (#3).
// `explanation` is the room-shared AI "why that answer" note, attached shortly
// AFTER reveal (it lands on a later session tick and the card re-renders).
interface ViewerPoll {
  id: string;
  // "branch" = a branch-point vote (choose-your-own-path): options are paths and
  // takenIndex is the routed-path breadcrumb once the presenter routes the room.
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
// the same session read. Dismiss is local per viewer; a new id shows again.
interface Recap {
  id: string;
  text: string;
  slideIndex: number;
  at: number;
}
// A presenter-broadcast Turn & Talk activity: a discussion/exercise prompt + a
// synchronized countdown, delivered on the same session read. Everyone counts
// down CLIENT-SIDE from `endsAt` (no per-second server traffic); "Regroup"
// clears it everywhere at once. Rendered ONLY in parent app-chrome — never
// posted into the sandboxed deck frame.
type ActivityFollowUp = "poll" | "pinboard";
interface Activity {
  id: string;
  prompt: string;
  endsAt: number; // epoch ms
  followUp: ActivityFollowUp | null;
  at: number;
}
// This viewer's personal "catch me up" recap: an on-demand AI summary of the
// slides between THEIR slide and the live slide. Local to the tab — never
// broadcast — so it lives here, not on the session poll.
interface CatchUp {
  from: number; // the viewer's slide (0-based) when they asked
  to: number; // the live slide at that moment
  text: string | null; // null until loaded
  error: string | null;
  loading: boolean;
}
// A question in the upvotable Q&A queue (#5).
interface QnaQuestion {
  id: string;
  name: string;
  text: string;
  votes: number;
  answered: boolean;
  dismissed: boolean;
  at: number;
}
// A branch-point path (lib/types.ts SlideBranch) — 0-based inclusive range.
interface SlideBranch {
  label: string;
  from: number;
  to: number;
}

// Presenter-side records (full poll incl. correct answer/tally; roster; signals).
interface Poll {
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
interface Viewer {
  name: string;
  index: number;
  follow: boolean;
}
interface Signal {
  name: string;
  kind: SignalKind;
  at: number;
}

// `role` defaults to "viewer" so the two untouched callers (the public home page
// and the embed-deck presenter console) keep the viewer experience; the deck page
// (/d/[slug]) passes role="presenter" when the request carries the presenter cookie.
export function UploadedDeckFrame({ deck: meta, role = "viewer" }: { deck: Deck; role?: Role }) {
  const slug = meta.slug;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const { isFullscreen, toggle } = useFullscreen();

  // Shared across roles.
  const [name, setName] = useState<string | null>(null);
  const [showGate, setShowGate] = useState(false);
  const [deck, setDeck] = useState<DeckState>({ index: 0, total: 0, label: "" });
  const [session, setSession] = useState<SessionState>({ index: 0, max: 0, live: false });
  const [chatOpen, setChatOpen] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  // Viewer.
  const [autoFollow, setAutoFollow] = useState(true);
  const [watching, setWatching] = useState(0);
  const [poll, setPoll] = useState<ViewerPoll | null>(null);
  const [myVote, setMyVote] = useState<{ pollId: string; optionIndex: number } | null>(null);
  const [qnaOpen, setQnaOpen] = useState(false);
  const [questions, setQuestions] = useState<QnaQuestion[]>([]);
  const [myVotes, setMyVotes] = useState<Record<string, boolean>>({});
  // Room recap (comprehension checkpoint): shared across roles — viewers render the
  // dismissible overlay; the presenter reads it for the "Clear recap" affordance.
  const [recap, setRecap] = useState<Recap | null>(null);
  const [dismissedRecapId, setDismissedRecapId] = useState<string | null>(null);
  // Turn & Talk activity: shared across roles — viewers render the countdown
  // card; the presenter reads it for the countdown + Regroup panel. Hide is
  // local per activity id (viewer only).
  const [activity, setActivity] = useState<Activity | null>(null);
  const [hiddenActivityId, setHiddenActivityId] = useState<string | null>(null);
  // Personal catch-up card (viewer): fetched on demand while behind; dismiss clears it.
  const [catchUp, setCatchUp] = useState<CatchUp | null>(null);

  // Presenter live-room panels.
  const [roster, setRoster] = useState<{ count: number; viewers: Viewer[] }>({ count: 0, viewers: [] });
  const [help, setHelp] = useState<{ lost: number; slow: number }>({ lost: 0, slow: 0 });
  const [reactionCount, setReactionCount] = useState(0);
  const [floats, setFloats] = useState<{ id: number; emoji: string; left: number }[]>([]);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [pollPanelOpen, setPollPanelOpen] = useState(false);
  const [livePoll, setLivePoll] = useState<Poll | null>(null);
  const [liveTally, setLiveTally] = useState<number[]>([]);
  const [liveTotal, setLiveTotal] = useState(0);
  // Branch points: index → authored paths (presenter only; fetched once, {} when
  // the DB is unavailable or the deck has none). Drives "Open branch vote".
  const [deckBranches, setDeckBranches] = useState<Record<number, SlideBranch[]>>({});
  // Comprehension checkpoint (presenter): recap send state + a pending "Launch
  // check" auto-draft the poll panel consumes on open.
  const [recapSending, setRecapSending] = useState(false);
  const [recapError, setRecapError] = useState<string | null>(null);
  const [pendingAutoDraft, setPendingAutoDraft] = useState(false);
  // Turn & Talk (presenter): the compose/countdown panel toggle. Shares the LEFT
  // column with the poll panel, so opening one closes the other.
  const [activityPanelOpen, setActivityPanelOpen] = useState(false);
  // Insight Engine (presenter): the live confusion-pulse aggregates (heat strip,
  // refreshed on the same ~4s presenter tick) + the debrief panel toggle. The
  // panel shares the LEFT column with the poll / Turn & Talk panels.
  const [pulseSlides, setPulseSlides] = useState<PulseSlideDto[]>([]);
  const [insightPanelOpen, setInsightPanelOpen] = useState(false);

  // Refs so the (stable) message/poll handlers always read live values.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const autoFollowRef = useRef(autoFollow);
  autoFollowRef.current = autoFollow;
  const nameRef = useRef(name);
  nameRef.current = name;
  const deckRef = useRef(deck);
  deckRef.current = deck;
  const voteCtrlRef = useRef<AbortController | null>(null);
  // In-flight catch-up request — aborted when superseded, dismissed, or unmounted.
  const catchUpCtrlRef = useRef<AbortController | null>(null);
  // Presenter tick guards (mirror PresenterConsole).
  const livePollRef = useRef(livePoll);
  livePollRef.current = livePoll;
  const closedPollIdRef = useRef<string | null>(null);
  const pollCtrlRef = useRef<AbortController | null>(null);
  // Latest recap + the id the presenter just cleared, so an in-flight pre-clear
  // session read can't resurrect it for one tick (same guard as closedPollIdRef).
  const recapRef = useRef(recap);
  recapRef.current = recap;
  const clearedRecapIdRef = useRef<string | null>(null);
  // Latest activity + the id the presenter just regrouped (same one-tick guard).
  const activityRef = useRef(activity);
  activityRef.current = activity;
  const clearedActivityIdRef = useRef<string | null>(null);
  const lastAtRef = useRef(0);
  const seededRef = useRef(false);
  const floatIdRef = useRef(0);
  const floatTimersRef = useRef<number[]>([]);
  const reduceMotionRef = useRef(reduceMotion);
  reduceMotionRef.current = reduceMotion;

  // ── SECURITY choke point — the ONLY function that posts to the untrusted frame.
  // targetOrigin is "*" (opaque frame); the DeckControlMessage union caps what can
  // ever be sent to navigation-only ints/enums. See header comment §2.
  const sendToDeck = useCallback((msg: DeckControlMessage) => {
    iframeRef.current?.contentWindow?.postMessage(msg, "*");
  }, []);

  // Free-roam bridge role: no clamp, no follow. Used for viewers with no live presenter.
  const sendFree = useCallback(() => {
    sendToDeck({ type: "deck:role", role: "viewer", max: 1e9, locked: false });
  }, [sendToDeck]);

  const pushRole = useCallback(() => {
    if (role === "presenter") {
      sendToDeck({ type: "deck:role", role: "presenter" });
      return;
    }
    const s = sessionRef.current;
    if (!s.live) sendFree();
    else sendToDeck({ type: "deck:role", role: "viewer", max: s.max, locked: autoFollowRef.current });
  }, [role, sendToDeck, sendFree]);

  // Sync THIS frame to `index` (a follow) — the deck reports it with reason 'api',
  // so it never re-drives the session. See the slidechange handler for loop-safety.
  const followTo = useCallback(
    (index: number) => {
      if (index !== deckRef.current.index) sendToDeck({ type: "deck:goto", index });
    },
    [sendToDeck],
  );

  // Presenter → broadcast a position, reset the lock, heartbeat, or take the clicker.
  const postPresenter = useCallback(
    async (opts: { index?: number; reset?: boolean; heartbeat?: boolean; takeClicker?: boolean }) => {
      try {
        const res = await fetch("/api/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, ...opts }),
        });
        if (res.ok) {
          // Only record a SERVER-CONFIRMED index. A failed POST must NOT advance the
          // dedupe ref, or re-navigating to that index would be silently dropped.
          if (typeof opts.index === "number") lastPostedIdxRef.current = opts.index;
          // Taking the clicker makes THIS frame the driver: forget the followed index
          // so the first local navigation always posts.
          else if (opts.takeClicker) lastPostedIdxRef.current = -1;
          setSession((await res.json()) as SessionState);
        }
      } catch {
        /* ignore — presenter keeps presenting */
      }
    },
    [slug],
  );

  // SECURITY (untrusted content): the deck reports slide changes, and the presenter
  // path turns a user-nav report into a POST /api/session. But an uploaded deck is
  // UNTRUSTED — a malicious one opened by a presenter can forge slidechange
  // {reason:"click", index} in a tight loop. Unlike LiveDeck's first-party deck, we
  // can't trust the report rate or `index`. The deck can't POST /api/session itself
  // (sandboxed opaque origin → cross-origin, no presenter cookie, assertSameOrigin
  // rejects it), so EVERY session write goes through this parent — which makes
  // coalescing HERE authoritative. We trailing-debounce to at most one write per
  // 250ms, drop duplicate indices, and clamp the (untrusted) index to a sane range.
  const pendingIdxRef = useRef<number | null>(null);
  const lastPostedIdxRef = useRef<number>(-1);
  const postTimerRef = useRef<number | null>(null);
  const schedulePresenterPost = useCallback(
    (rawIdx: number) => {
      pendingIdxRef.current = Math.max(0, Math.min(9999, Math.floor(rawIdx) || 0));
      if (postTimerRef.current != null) return; // a trailing write is already queued
      postTimerRef.current = window.setTimeout(() => {
        postTimerRef.current = null;
        const next = pendingIdxRef.current;
        pendingIdxRef.current = null;
        if (next == null || next === lastPostedIdxRef.current) return;
        // The ref is advanced only once postPresenter confirms the write, so a
        // failed POST leaves it on the last server-held index (retry stays possible).
        void postPresenter({ index: next });
      }, 250);
    },
    [postPresenter],
  );
  useEffect(
    () => () => {
      if (postTimerRef.current != null) window.clearTimeout(postTimerRef.current);
    },
    [],
  );

  // ── viewer backchannel actions (ported from LiveDeck) ──
  const sendSignal = useCallback(
    async (kind: SignalKind) => {
      const who = nameRef.current;
      if (!who) return;
      try {
        await fetch("/api/signal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, name: who, kind }),
        });
      } catch {
        /* best-effort */
      }
    },
    [slug],
  );

  const castVote = useCallback(
    async (pollId: string, optionIndex: number) => {
      const who = nameRef.current;
      if (!who) return;
      voteCtrlRef.current?.abort();
      const ctrl = new AbortController();
      voteCtrlRef.current = ctrl;
      setMyVote({ pollId, optionIndex });
      try {
        const res = await fetch("/api/poll/vote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, pollId, optionIndex, name: who }),
          signal: ctrl.signal,
        });
        if (!res.ok) setMyVote((m) => (m && m.pollId === pollId ? null : m));
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setMyVote((m) => (m && m.pollId === pollId ? null : m));
      }
    },
    [slug],
  );

  // "Catch me up": fetch an AI recap of the slides between THIS viewer's slide
  // and the live slide. The server caches per (slug, from, liveTo), so a room of
  // late joiners at the same slide shares one generation. Nameless viewers ask as
  // "Viewer" — the same gate as the chat sidebar (the name only feeds the
  // privacy-safe token accounting, never a broadcast). All in PARENT app-chrome —
  // nothing is ever posted into the sandboxed deck frame.
  const requestCatchUp = useCallback(async () => {
    const from = deckRef.current.index;
    const to = sessionRef.current.index;
    if (to <= from) return; // caught up between render and tap
    catchUpCtrlRef.current?.abort();
    const ctrl = new AbortController();
    catchUpCtrlRef.current = ctrl;
    setCatchUp({ from, to, text: null, error: null, loading: true });
    try {
      const res = await fetch("/api/catchup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, name: nameRef.current || "Viewer", from, to }),
        signal: ctrl.signal,
      });
      const data = (await res.json().catch(() => ({}))) as { recap?: string; error?: string };
      if (!res.ok || !data.recap) {
        setCatchUp({ from, to, text: null, error: mapCatchUpError(data.error), loading: false });
        return;
      }
      setCatchUp({ from, to, text: data.recap, error: null, loading: false });
    } catch (err) {
      // Superseded by a newer tap or dismissed — that action owns the state now.
      if (err instanceof DOMException && err.name === "AbortError") return;
      setCatchUp({ from, to, text: null, error: "Couldn't catch you up — try again.", loading: false });
    }
  }, [slug]);

  const upvoteQuestion = useCallback(
    async (qid: string) => {
      const who = nameRef.current;
      if (!who) {
        setShowGate(true);
        return;
      }
      setMyVotes((m) => (m[qid] ? m : { ...m, [qid]: true }));
      try {
        const res = await fetch("/api/qna", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, action: "upvote", qid, name: who }),
        });
        if (res.ok) {
          const { votes } = (await res.json()) as { votes?: number };
          if (typeof votes === "number") {
            setQuestions((qs) => qs.map((q) => (q.id === qid ? { ...q, votes } : q)));
          }
        } else {
          setMyVotes((m) => {
            const n = { ...m };
            delete n[qid];
            return n;
          });
        }
      } catch {
        setMyVotes((m) => {
          const n = { ...m };
          delete n[qid];
          return n;
        });
      }
    },
    [slug],
  );

  const askQuestion = useCallback(
    async (text: string): Promise<string | null> => {
      const who = nameRef.current;
      if (!who) {
        setShowGate(true);
        return "Enter a name to ask.";
      }
      const t = text.trim();
      if (!t) return null;
      try {
        const res = await fetch("/api/qna", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, action: "ask", name: who, text: t }),
        });
        if (res.ok) {
          const { question } = (await res.json()) as { question?: QnaQuestion };
          if (question) {
            setQuestions((qs) => (qs.some((q) => q.id === question.id) ? qs : [...qs, question]));
          }
          return null;
        }
        if (res.status === 429) return "You're doing that too fast.";
        return "Couldn't post — the queue may be full.";
      } catch {
        return "Couldn't post — try again.";
      }
    },
    [slug],
  );

  // ── presenter poll control (ported from PresenterConsole) ──
  const pollAction = useCallback(
    async (body: Record<string, unknown>) => {
      pollCtrlRef.current?.abort();
      const ctrl = new AbortController();
      pollCtrlRef.current = ctrl;
      return fetch("/api/poll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, ...body }),
        signal: ctrl.signal,
      });
    },
    [slug],
  );

  const openPollAction = useCallback(
    async (question: string, options: string[], correctIndex: number | null): Promise<boolean> => {
      try {
        const res = await pollAction({ action: "open", question, options, correctIndex });
        if (!res.ok) return false;
        const data = (await res.json()) as { poll: Poll; tally?: number[]; total?: number };
        closedPollIdRef.current = null;
        setLivePoll(data.poll);
        setLiveTally(data.tally ?? new Array(data.poll.options.length).fill(0));
        setLiveTotal(data.total ?? 0);
        return true;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return false;
        return false;
      }
    },
    [pollAction],
  );

  const revealPollAction = useCallback(async () => {
    try {
      const res = await pollAction({ action: "reveal" });
      if (!res.ok) return;
      const data = (await res.json()) as { poll: Poll; tally?: number[]; total?: number };
      setLivePoll(data.poll);
      setLiveTally(data.tally ?? []);
      setLiveTotal(data.total ?? 0);
    } catch {
      /* aborted / transient — the tick reconciles */
    }
  }, [pollAction]);

  const closePollAction = useCallback(async () => {
    closedPollIdRef.current = livePollRef.current?.id ?? null;
    setLivePoll(null);
    setLiveTally([]);
    setLiveTotal(0);
    try {
      await pollAction({ action: "close" });
    } catch {
      /* aborted / transient */
    }
  }, [pollAction]);

  // Branch points: open the audience vote on the CURRENT slide's authored paths.
  // The server reads the paths from deck_slides — the body only names the slide.
  const openBranchAction = useCallback(async (): Promise<boolean> => {
    try {
      const res = await pollAction({ action: "open", kind: "branch", index: deckRef.current.index });
      if (!res.ok) return false;
      const data = (await res.json()) as { poll: Poll; tally?: number[]; total?: number };
      closedPollIdRef.current = null;
      setLivePoll(data.poll);
      setLiveTally(data.tally ?? new Array(data.poll.options.length).fill(0));
      setLiveTotal(data.total ?? 0);
      return true;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return false;
      return false;
    }
  }, [pollAction]);

  // Route the room to a branch (post-reveal). The server does the driver-gated
  // session jump; on success we sync THIS frame too — the goto reports back with
  // reason 'api', so it never re-drives the session (see followTo).
  const routeBranchAction = useCallback(
    async (optionIndex: number): Promise<boolean> => {
      try {
        const res = await pollAction({ action: "route", optionIndex });
        if (!res.ok) return false;
        const data = (await res.json()) as { poll?: Poll; index?: number; routed?: boolean };
        if (data.poll) setLivePoll(data.poll);
        if (data.routed && typeof data.index === "number") {
          lastPostedIdxRef.current = data.index; // the server already holds it
          followTo(data.index);
        }
        return data.routed === true;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return false;
        return false;
      }
    },
    [pollAction, followTo],
  );

  // Load this deck's branch points once (presenter only; silently {} when there
  // are none or the DB is down — the affordance simply doesn't appear).
  useEffect(() => {
    if (role !== "presenter") return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/branches?slug=${encodeURIComponent(slug)}`, {
          cache: "no-store",
        });
        if (!res.ok || !alive) return;
        const data = (await res.json()) as { branches?: Record<number, SlideBranch[]> };
        if (alive && data.branches) setDeckBranches(data.branches);
      } catch {
        /* no branch affordance */
      }
    })();
    return () => {
      alive = false;
    };
  }, [role, slug]);

  // ── presenter comprehension checkpoint (ported from PresenterConsole) ──
  // "Send recap" resolves + broadcasts an AI recap of the CURRENT slide (the server
  // is cache-first, so a repeat is free); "Clear recap" removes the viewers' overlay.
  const sendRecap = useCallback(async () => {
    setRecapSending(true);
    setRecapError(null);
    try {
      const res = await fetch("/api/recap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, slideIndex: deckRef.current.index }),
      });
      const data = (await res.json().catch(() => ({}))) as { recap?: Recap; error?: string };
      if (!res.ok || !data.recap) {
        setRecapError(mapRecapError(data.error));
        return;
      }
      clearedRecapIdRef.current = null;
      setRecap(data.recap);
    } catch {
      setRecapError("Couldn't send — try again.");
    } finally {
      setRecapSending(false);
    }
  }, [slug]);

  const clearRecapAction = useCallback(async () => {
    // Remember the id so an in-flight pre-clear session read can't resurrect it,
    // then optimistically drop it.
    clearedRecapIdRef.current = recapRef.current?.id ?? null;
    setRecap(null);
    setRecapError(null);
    try {
      await fetch(`/api/recap?slug=${encodeURIComponent(slug)}`, { method: "DELETE" });
    } catch {
      /* transient — worst case the next session read restores it */
    }
  }, [slug]);

  // ── presenter Turn & Talk (ported from PresenterConsole) ──
  // "Start" broadcasts the prompt + a synchronized countdown (the server computes
  // endsAt at write time, so the whole room counts down to the same instant);
  // "Regroup" ends it everywhere at once and, for a "poll" follow-up, chains into
  // the SAME reviewed ✨ draft flow as "Launch check" (never auto-launches).
  const startActivity = useCallback(
    async (prompt: string, durationSec: number, followUp: ActivityFollowUp | null): Promise<boolean> => {
      try {
        const res = await fetch("/api/activity", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, prompt, durationSec, followUp }),
        });
        if (!res.ok) return false;
        const data = (await res.json()) as { activity?: Activity };
        if (!data.activity) return false;
        clearedActivityIdRef.current = null;
        setActivity(data.activity);
        return true;
      } catch {
        return false;
      }
    },
    [slug],
  );

  const regroupActivity = useCallback(async () => {
    // Remember the id so an in-flight pre-clear session read can't resurrect it,
    // then optimistically drop it (same guard as clearRecapAction).
    const followUp = activityRef.current?.followUp ?? null;
    clearedActivityIdRef.current = activityRef.current?.id ?? null;
    setActivity(null);
    try {
      await fetch(`/api/activity?slug=${encodeURIComponent(slug)}`, { method: "DELETE" });
    } catch {
      /* transient — worst case the next session read restores it */
    }
    if (followUp === "poll") {
      setActivityPanelOpen(false);
      setPollPanelOpen(true);
      setPendingAutoDraft(true);
    }
  }, [slug]);

  // ── presenter Q&A control (ported from PresenterConsole) ──
  const qnaAction = useCallback(
    async (action: "answer" | "dismiss" | "undismiss", qid: string) => {
      try {
        const res = await fetch("/api/qna", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, action, qid }),
        });
        if (res.ok) {
          const data = (await res.json()) as { questions?: QnaQuestion[] };
          if (data.questions) setQuestions(data.questions);
        }
      } catch {
        /* transient — the tick will refresh */
      }
    },
    [slug],
  );

  // Load stored viewer name (best-effort — localStorage can throw). Presenter chats
  // as "Presenter", but a stored name is still harmless to read.
  useEffect(() => {
    try {
      const n = localStorage.getItem(NAME_KEY);
      if (n) setName(n);
    } catch {
      /* ignore */
    }
  }, []);

  // A fresh poll id means a brand-new question — drop any prior "your choice".
  const pollId = poll?.id ?? null;
  useEffect(() => {
    setMyVote(null);
  }, [pollId]);

  // Honor prefers-reduced-motion (viewer poll bars + presenter reaction floats).
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduceMotion(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // Abort any in-flight vote / catch-up / poll-control request when the deck unmounts.
  useEffect(() => () => voteCtrlRef.current?.abort(), []);
  useEffect(() => () => catchUpCtrlRef.current?.abort(), []);
  useEffect(() => () => pollCtrlRef.current?.abort(), []);
  useEffect(
    () => () => {
      floatTimersRef.current.forEach((t) => window.clearTimeout(t));
      floatTimersRef.current = [];
    },
    [],
  );

  // Viewer Q&A queue poll (#5): runs only while the panel is open (spares Redis).
  useEffect(() => {
    if (role !== "viewer" || !qnaOpen || showGate) return;
    let alive = true;
    let timer: number | undefined;
    const ctrl = new AbortController();

    async function pull() {
      try {
        const res = await fetch(`/api/qna?slug=${encodeURIComponent(slug)}`, {
          cache: "no-store",
          signal: ctrl.signal,
        });
        if (!res.ok || !alive) return;
        const data = (await res.json()) as { questions?: QnaQuestion[] };
        if (alive) setQuestions(data.questions ?? []);
      } catch {
        /* transient / aborted */
      }
    }
    function nextDelay(): number {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return QNA_HIDDEN_MS;
      return QNA_POLL_MS;
    }
    async function loop() {
      if (!alive) return;
      await pull();
      if (!alive) return;
      timer = window.setTimeout(loop, nextDelay());
    }
    void loop();
    const onVisible = () => {
      if (!alive || document.visibilityState !== "visible") return;
      window.clearTimeout(timer);
      void loop();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      ctrl.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [role, qnaOpen, showGate, slug]);

  // Messages from the deck bridge (receive guard: our frame's window + deck marker).
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      const d = (e.data ?? {}) as { source?: string; type?: string; reason?: string } & Partial<DeckState>;
      // SECURITY GUARD — object-identity of OUR frame + the deck marker. We do NOT
      // check event.origin ("null" for an opaque sandbox). See header comment §1.
      if (!(e.source === iframeRef.current?.contentWindow && d.source === "deck")) return;
      if (d.type === "ready") {
        pushRole();
        if (role === "viewer" && autoFollowRef.current && sessionRef.current.live) {
          followTo(sessionRef.current.index);
        }
      } else if (d.type === "slidechange") {
        const idx = d.index ?? 0;
        // SECURITY (untrusted content): `total`/`label` are attacker-controlled just
        // like `index`. Clamp `total` (it drives a per-slide render loop in
        // PulseHeatStrip — an unbounded value freezes/OOM-crashes the tab) and cap the
        // label, mirroring the index clamp in schedulePresenterPost.
        const total = Math.min(Math.max(0, Math.floor(Number(d.total) || 0)), 9999);
        const label = String(d.label ?? "").slice(0, 200);
        setDeck({ index: idx, total, label });
        // LOOP-SAFETY: only the PRESENTER's OWN navigation drives the session. A
        // followed move is reported with reason 'api' (init/sync for boot pings) —
        // never re-POSTed. Viewers never drive at all.
        const userNav = d.reason !== "api" && d.reason !== "init" && d.reason !== "sync";
        // Debounced + clamped: a forged slidechange flood can't amplify into
        // unbounded authenticated session writes. See schedulePresenterPost.
        // Co-host mode: a moderator (clicker held by the co-host) never writes the
        // shared index — the server would ignore it anyway.
        if (role === "presenter" && userNav && sessionRef.current.isDriver !== false) {
          schedulePresenterPost(idx);
        }
      }
      // `activity` is ignored — no auto-hiding presenter overlay here.
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [role, pushRole, followTo, schedulePresenterPost]);

  // Poll the shared session. Viewers lock/follow while a presenter is live and
  // browse freely otherwise; presenters read it for the "viewers unlocked" display.
  useEffect(() => {
    if (role === "viewer" && showGate) return;
    let alive = true;
    let timer: number | undefined;
    let lastLive = false;
    const ctrl = new AbortController();

    // Viewer presence heartbeat (#1) on the SAME tick as the session read — name-gated.
    async function beat() {
      const who = nameRef.current;
      if (role !== "viewer" || !who) return;
      try {
        const res = await fetch("/api/presence", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slug,
            name: who,
            index: deckRef.current.index,
            follow: autoFollowRef.current,
          }),
          signal: ctrl.signal,
        });
        if (!res.ok || !alive) return;
        const data = (await res.json()) as { watching?: number };
        if (alive && typeof data.watching === "number") setWatching(data.watching);
      } catch {
        /* transient / aborted */
      }
    }

    async function pull() {
      try {
        const res = await fetch(`/api/session?slug=${encodeURIComponent(slug)}`, {
          cache: "no-store",
          signal: ctrl.signal,
        });
        if (!res.ok || !alive) return;
        const s = (await res.json()) as SessionState & {
          poll?: ViewerPoll | null;
          recap?: Recap | null;
          activity?: Activity | null;
        };
        lastLive = s.live;
        setSession(s);
        // The room recap rides this same read for BOTH roles (viewers render the
        // overlay; the presenter needs it for "Clear recap"). Skip the one the
        // presenter just cleared — its id can linger for one in-flight tick.
        const r = s.recap ?? null;
        if (!r || r.id !== clearedRecapIdRef.current) setRecap(r);
        // The Turn & Talk activity rides here too, for BOTH roles (viewers render
        // the countdown card; the presenter needs it for the Regroup panel).
        const a = s.activity ?? null;
        if (!a || a.id !== clearedActivityIdRef.current) setActivity(a);
        if (role === "presenter") {
          // Co-host mode: a moderator follows the driver (the goto reports back as
          // reason 'api', so it never re-drives). The driver drives locally, never
          // from this poll.
          if (s.isDriver === false) {
            // Keep the dedupe ref on the server-confirmed index while following, so
            // reclaiming the clicker and navigating back here still posts.
            lastPostedIdxRef.current = s.index;
            followTo(s.index);
          }
          return;
        }
        setPoll(s.poll ?? null);
        void beat();
        if (!s.live) {
          sendFree();
          return;
        }
        sendToDeck({ type: "deck:role", role: "viewer", max: s.max, locked: autoFollowRef.current });
        if (autoFollowRef.current) followTo(s.index);
      } catch {
        /* transient */
      }
    }

    function nextDelay(): number {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return HIDDEN_POLL_MS;
      if (role === "presenter") return PRESENTER_POLL_MS;
      return lastLive ? POLL_MS : IDLE_POLL_MS;
    }
    async function loop() {
      if (!alive) return;
      await pull();
      if (!alive) return;
      timer = window.setTimeout(loop, nextDelay());
    }
    void loop();
    const onVisible = () => {
      if (!alive || document.visibilityState !== "visible") return;
      window.clearTimeout(timer);
      void loop();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      ctrl.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [role, showGate, slug, sendToDeck, sendFree, followTo]);

  // Viewer: react to the auto-follow toggle (only meaningful while live).
  useEffect(() => {
    if (role !== "viewer") return;
    const s = sessionRef.current;
    if (!s.live) {
      sendFree();
      return;
    }
    sendToDeck({ type: "deck:role", role: "viewer", max: s.max, locked: autoFollow });
    if (autoFollow) followTo(s.index);
  }, [autoFollow, role, sendToDeck, sendFree, followTo]);

  // Presenter: heartbeat so viewers know a session is live even between moves.
  useEffect(() => {
    if (role !== "presenter") return;
    void postPresenter({ heartbeat: true });
    const id = window.setInterval(() => void postPresenter({ heartbeat: true }), 10_000);
    return () => window.clearInterval(id);
  }, [role, postPresenter]);

  // Presenter live-room tick (#1 roster / #2 reactions + help meter / #3 poll /
  // #5 Q&A) — one ~4s timer, hidden-tab backoff, abort-on-unmount. Ported from
  // PresenterConsole. Presenter-gated GETs (this page carries the presenter cookie).
  useEffect(() => {
    if (role !== "presenter") return;
    let alive = true;
    let timer: number | undefined;
    const ctrl = new AbortController();
    const enc = encodeURIComponent(slug);

    function spawnFloat(emoji: string) {
      if (!alive) return;
      const id = ++floatIdRef.current;
      const left = 10 + Math.random() * 66;
      setFloats((f) => [...f, { id, emoji, left }]);
      const t = window.setTimeout(() => {
        floatTimersRef.current = floatTimersRef.current.filter((x) => x !== t);
        if (!alive) return;
        setFloats((f) => f.filter((x) => x.id !== id));
      }, 2100);
      floatTimersRef.current.push(t);
    }

    function onSignals(list: Signal[]) {
      const maxAt = list.length ? list[0].at : lastAtRef.current; // newest-first
      if (!seededRef.current) {
        seededRef.current = true;
        lastAtRef.current = list.length ? maxAt : 0;
        return;
      }
      const fresh = list.filter((s) => s.at > lastAtRef.current && ANIMATE_KINDS.has(s.kind));
      if (list.length) lastAtRef.current = Math.max(lastAtRef.current, maxAt);
      if (!fresh.length || reduceMotionRef.current) return;
      fresh
        .slice()
        .reverse()
        .forEach((s, i) => {
          const t = window.setTimeout(() => {
            floatTimersRef.current = floatTimersRef.current.filter((x) => x !== t);
            spawnFloat(REACTION_EMOJI[s.kind] ?? "✨");
          }, i * 140);
          floatTimersRef.current.push(t);
        });
    }

    async function tick() {
      try {
        const [pRes, sRes, qRes, qaRes, plRes] = await Promise.all([
          fetch(`/api/presence?slug=${enc}`, { cache: "no-store", signal: ctrl.signal }),
          fetch(`/api/signal?slug=${enc}`, { cache: "no-store", signal: ctrl.signal }),
          fetch(`/api/poll?slug=${enc}`, { cache: "no-store", signal: ctrl.signal }),
          fetch(`/api/qna?slug=${enc}`, { cache: "no-store", signal: ctrl.signal }),
          fetch(`/api/pulse?slug=${enc}`, { cache: "no-store", signal: ctrl.signal }),
        ]);
        if (alive && pRes.ok) {
          const data = (await pRes.json()) as { count?: number; viewers?: Viewer[] };
          setRoster({ count: data.count ?? 0, viewers: data.viewers ?? [] });
        }
        if (alive && sRes.ok) {
          const sig = (await sRes.json()) as { signals?: Signal[]; lost?: number; slow?: number };
          const list = sig.signals ?? [];
          setHelp({ lost: sig.lost ?? 0, slow: sig.slow ?? 0 });
          setReactionCount(list.filter((s) => ANIMATE_KINDS.has(s.kind)).length);
          onSignals(list);
        }
        if (alive && qRes.ok) {
          const data = (await qRes.json()) as { poll?: Poll | null; tally?: number[]; total?: number };
          const incoming = data.poll ?? null;
          const cur = livePollRef.current;
          const stale =
            !!incoming &&
            (incoming.id === closedPollIdRef.current ||
              (!!cur && cur.id === incoming.id && cur.revealed && !incoming.revealed));
          if (!stale) {
            setLivePoll(incoming);
            setLiveTally(incoming ? data.tally ?? [] : []);
            setLiveTotal(incoming ? data.total ?? 0 : 0);
          }
        }
        if (alive && qaRes.ok) {
          const data = (await qaRes.json()) as { questions?: QnaQuestion[] };
          setQuestions(data.questions ?? []);
        }
        if (alive && plRes.ok) {
          const data = (await plRes.json()) as { slides?: PulseSlideDto[] };
          setPulseSlides(data.slides ?? []);
        }
      } catch {
        /* transient / aborted */
      }
    }

    function nextDelay(): number {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return PRESENCE_HIDDEN_MS;
      return PRESENCE_POLL_MS;
    }
    async function loop() {
      if (!alive) return;
      await tick();
      if (!alive) return;
      timer = window.setTimeout(loop, nextDelay());
    }
    void loop();
    const onVisible = () => {
      if (!alive || document.visibilityState !== "visible") return;
      window.clearTimeout(timer);
      void loop();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      ctrl.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [role, slug]);

  // Cover the boot race: the deck may fire its first `slidechange` before this
  // component's listener attached. Keep pinging deck:report until we have a count.
  useEffect(() => {
    if (!meta.contentUrl || deck.total > 0) return;
    sendToDeck({ type: "deck:report" });
    const id = window.setInterval(() => sendToDeck({ type: "deck:report" }), 350);
    return () => window.clearInterval(id);
  }, [meta.contentUrl, deck.total, sendToDeck]);

  const saveName = (n: string) => {
    const clean = n.trim().slice(0, 40);
    if (!clean) return;
    try {
      localStorage.setItem(NAME_KEY, clean);
    } catch {
      /* ignore */
    }
    setName(clean);
    setShowGate(false);
  };

  // contentUrl is undefined when DECK_ORIGIN is unset — we must NEVER serve untrusted
  // content from the app's own origin, so surface a neutral "unavailable" state. All
  // hooks above run unconditionally, so this early return never changes hook order.
  if (!meta.contentUrl) {
    return (
      <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: "2rem", textAlign: "center" }}>
        <p style={{ opacity: 0.7, fontSize: "1.1rem" }}>This deck can’t be displayed right now.</p>
      </main>
    );
  }

  const behind = role === "viewer" && session.live && !autoFollow ? session.index - deck.index : 0;
  const unlockedTo = session.max; // 0-based
  const chatName = role === "presenter" ? "Presenter" : name ?? "Viewer";
  // Co-host mode: does THIS presenter hold the clicker? Absent (solo/legacy or an
  // unclaimed session) counts as yes, so a lone presenter is never gated.
  const isDriver = session.isDriver !== false;

  // Presenter roster breakdown against the presenter's CURRENT slide (#1).
  const presenterIdx = deck.index;
  let following = 0;
  let rosterBehind = 0;
  let exploring = 0;
  for (const v of roster.viewers) {
    if (v.follow) following += 1;
    else if (v.index < presenterIdx) rosterBehind += 1;
    else exploring += 1;
  }
  const qnaActiveCount = questions.reduce((n, q) => (q.dismissed ? n : n + 1), 0);

  return (
    <div ref={stageRef} style={{ position: "fixed", inset: 0, background: "#ECEAE3", display: "flex" }}>
      {role === "presenter" && <style>{FLOAT_KEYFRAMES}</style>}
      <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
        <iframe
          ref={iframeRef}
          src={meta.contentUrl}
          title={meta.title}
          sandbox="allow-scripts"
          allow="fullscreen"
          onLoad={() => sendToDeck({ type: "deck:report" })}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0, display: "block" }}
        />

        {/* Presenter: floating viewer reactions (#2) rise + fade over the slide. */}
        {role === "presenter" && (
          <div style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden", zIndex: 5 }} aria-hidden>
            {!reduceMotion && floats.map((f) => (
              <span key={f.id} style={floatStyle(f.left)}>
                {f.emoji}
              </span>
            ))}
            {reduceMotion && reactionCount > 0 && (
              <span style={reactionBadge}>
                {reactionCount} reaction{reactionCount === 1 ? "" : "s"}
              </span>
            )}
          </div>
        )}

        {/* Presenter help meter (#2) + comprehension-check fixes — top-left so
            they clear the right cluster. */}
        {role === "presenter" && (
          <div style={{ position: "absolute", top: 14, left: 16, zIndex: 39, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", maxWidth: "min(640px, calc(100% - 32px))" }}>
            <HelpMeter lost={help.lost} slow={help.slow} />
            <ComprehensionCheck
              show={help.lost >= LOST_THRESHOLD}
              recapActive={!!recap}
              sending={recapSending}
              error={recapError}
              pollLive={!!livePoll}
              onSendRecap={() => void sendRecap()}
              onClearRecap={() => void clearRecapAction()}
              onLaunchCheck={() => {
                // Reuse the reviewed ✨ draft flow: open the poll panel with a
                // pending auto-draft (never auto-launches — the presenter reviews).
                setPollPanelOpen(true);
                setPendingAutoDraft(true);
              }}
            />
          </div>
        )}

        {/* top-right control cluster */}
        <div
          style={{
            position: "absolute",
            top: 14,
            right: 16,
            zIndex: 40,
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            justifyContent: "flex-end",
            maxWidth: "calc(100% - 32px)",
          }}
        >
          <FullscreenButton active={isFullscreen} onClick={() => void toggle(stageRef.current)} />
          {role === "viewer" ? (
            <>
              {session.live ? (
                <>
                  {behind > 0 && (
                    <>
                      <button onClick={() => setAutoFollow(true)} style={pill("#2C2A31", "#F4F2EC")} title="Jump to the presenter">
                        {behind} {behind === 1 ? "slide" : "slides"} behind · catch up
                      </button>
                      <button
                        onClick={() => void requestCatchUp()}
                        disabled={!!catchUp?.loading}
                        style={{ ...pill("rgba(255,255,255,0.62)", "#2C2A31"), border: "1px solid rgba(255,255,255,0.85)", gap: 6 }}
                        title="Get a quick AI recap of the slides you missed"
                      >
                        ✨ Catch me up
                      </button>
                    </>
                  )}
                  <FollowToggle on={autoFollow} onChange={setAutoFollow} />
                </>
              ) : (
                <span style={glassChip()} title="No one is presenting — page through freely">
                  Browsing freely
                </span>
              )}
              {name && watching >= 1 && (
                <span style={glassChip()} title="People watching this deck right now">
                  👁 {watching} watching
                </span>
              )}
              {name && <ReactionBar onSend={sendSignal} />}
              <QnaButton open={qnaOpen} count={questions.length} onClick={() => setQnaOpen((o) => !o)} />
              <ChatButton open={chatOpen} onClick={() => setChatOpen((o) => !o)} />
              {name && <span style={glassChip()}>{name}</span>}
            </>
          ) : (
            <>
              <PresenceChip
                watching={roster.count}
                following={following}
                exploring={exploring}
                behind={rosterBehind}
                viewers={roster.viewers}
                open={rosterOpen}
                onOpenChange={setRosterOpen}
              />
              <span style={glassChip()}>Unlocked → slide {unlockedTo + 1}</span>
              {isDriver ? (
                <span style={glassChip()} title="You control the room's slide position">
                  🖱 You have the clicker
                </span>
              ) : (
                <button
                  onClick={() => void postPresenter({ takeClicker: true })}
                  style={pill("#BFE048", "#1B1B20")}
                  title="Take slide control from your co-host"
                >
                  🖱 Take the clicker
                </button>
              )}
              <button
                onClick={() =>
                  setPollPanelOpen((o) => {
                    // The poll + Turn & Talk + Insights panels share the LEFT
                    // column — only one may be open at a time.
                    if (!o) {
                      setActivityPanelOpen(false);
                      setInsightPanelOpen(false);
                    }
                    return !o;
                  })
                }
                aria-pressed={pollPanelOpen}
                title="Live poll & AI knowledge-check"
                style={pill(pollPanelOpen ? "#2C2A31" : "rgba(255,255,255,0.62)", pollPanelOpen ? "#F4F2EC" : "#2C2A31")}
              >
                📊 Poll{livePoll ? (livePoll.revealed ? " · revealed" : " · live") : ""}
              </button>
              <button
                onClick={() =>
                  setActivityPanelOpen((o) => {
                    if (!o) {
                      setPollPanelOpen(false);
                      setInsightPanelOpen(false);
                    }
                    return !o;
                  })
                }
                aria-pressed={activityPanelOpen}
                title="Turn & Talk — broadcast a discussion prompt + countdown to every viewer"
                style={pill(activityPanelOpen ? "#2C2A31" : "rgba(255,255,255,0.62)", activityPanelOpen ? "#F4F2EC" : "#2C2A31")}
              >
                ⏱ Turn &amp; Talk{activity ? " · live" : ""}
              </button>
              <button
                onClick={() =>
                  setInsightPanelOpen((o) => {
                    if (!o) {
                      setPollPanelOpen(false);
                      setActivityPanelOpen(false);
                    }
                    return !o;
                  })
                }
                aria-pressed={insightPanelOpen}
                title="Room insights — where viewers are struggling + the AI session debrief"
                style={pill(insightPanelOpen ? "#2C2A31" : "rgba(255,255,255,0.62)", insightPanelOpen ? "#F4F2EC" : "#2C2A31")}
              >
                🔥 Insights
              </button>
              <button
                onClick={() => setQnaOpen((o) => !o)}
                aria-pressed={qnaOpen}
                title="Audience questions & AI confusion digest"
                style={pill(qnaOpen ? "#2C2A31" : "rgba(255,255,255,0.62)", qnaOpen ? "#F4F2EC" : "#2C2A31")}
              >
                ❓ Questions{qnaActiveCount > 0 ? ` · ${qnaActiveCount}` : ""}
              </button>
              <button onClick={() => void postPresenter({ reset: true })} style={pill("#B5331F", "#FFF")} title="Set the current slide as the viewers' ceiling">
                Reset lock
              </button>
              <ChatButton open={chatOpen} onClick={() => setChatOpen((o) => !o)} />
            </>
          )}
        </div>

        {/* Viewer live-poll card (#3) — bottom-left so it clears the top controls. */}
        {role === "viewer" && poll && (
          <PollCard
            poll={poll}
            hasName={!!name}
            myOptionIndex={myVote && myVote.pollId === poll.id ? myVote.optionIndex : null}
            reduceMotion={reduceMotion}
            onVote={(i) => void castVote(poll.id, i)}
            onNeedName={() => setShowGate(true)}
          />
        )}

        {/* Bottom-center card stack — the Turn & Talk activity card, the room
            recap (presenter-broadcast) and this viewer's personal catch-up card
            share one column so they never overlap. All live in PARENT app-chrome
            (NEVER posted into the sandboxed deck iframe) and clear the poll card
            and Q&A panel. */}
        {role === "viewer" &&
          ((activity && activity.id !== hiddenActivityId) ||
            (recap && recap.id !== dismissedRecapId) ||
            catchUp) && (
          <div style={centerCardStack}>
            {activity && activity.id !== hiddenActivityId && (
              <ActivityCard activity={activity} onHide={() => setHiddenActivityId(activity.id)} />
            )}
            {recap && recap.id !== dismissedRecapId && (
              <RecapCard recap={recap} onDismiss={() => setDismissedRecapId(recap.id)} />
            )}
            {catchUp && (
              <CatchUpCard
                catchUp={catchUp}
                onDismiss={() => {
                  catchUpCtrlRef.current?.abort();
                  setCatchUp(null);
                }}
              />
            )}
          </div>
        )}

        {/* Viewer Q&A queue (#5) — right column below the top controls. */}
        {role === "viewer" && qnaOpen && (
          <QnaPanel
            questions={questions}
            hasName={!!name}
            myVotes={myVotes}
            onUpvote={(qid) => void upvoteQuestion(qid)}
            onAsk={askQuestion}
            onNeedName={() => setShowGate(true)}
            onClose={() => setQnaOpen(false)}
          />
        )}

        {/* Presenter poll panel (#3/#4) — compose · AI draft · live results (left). */}
        {role === "presenter" && pollPanelOpen && (
          <PresenterPollPanel
            poll={livePoll}
            tally={liveTally}
            total={liveTotal}
            slug={slug}
            index={deck.index}
            branches={deckBranches[deck.index] ?? null}
            reduceMotion={reduceMotion}
            autoDraft={pendingAutoDraft}
            onAutoDraftDone={() => setPendingAutoDraft(false)}
            onLaunch={openPollAction}
            onOpenBranch={openBranchAction}
            onRoute={routeBranchAction}
            onReveal={revealPollAction}
            onClose={closePollAction}
            onDismiss={() => setPollPanelOpen(false)}
          />
        )}

        {/* Presenter Q&A panel (#5) — digest · queue · answer/dismiss · AI answer (right). */}
        {role === "presenter" && qnaOpen && (
          <PresenterQnaPanel
            questions={questions}
            slug={slug}
            index={deck.index}
            onAction={qnaAction}
            onDismiss={() => setQnaOpen(false)}
          />
        )}

        {/* Presenter Turn & Talk panel — compose (prompt · duration · follow-up)
            or the running countdown + Regroup (left, exclusive with the poll panel). */}
        {role === "presenter" && activityPanelOpen && (
          <PresenterActivityPanel
            activity={activity}
            onStart={startActivity}
            onRegroup={() => void regroupActivity()}
            onDismiss={() => setActivityPanelOpen(false)}
          />
        )}

        {/* Presenter Insight panel — live struggle breakdown + the AI session
            debrief (left, exclusive with the poll / Turn & Talk panels). */}
        {role === "presenter" && insightPanelOpen && (
          <div style={presenterPollWrap}>
            <InsightPanel
              slug={slug}
              slides={pulseSlides}
              variant="light"
              onDismiss={() => setInsightPanelOpen(false)}
            />
          </div>
        )}

        {/* Presenter confusion heat strip (Insight Engine) — one cell per slide,
            bottom of the stage so it never collides with the top control
            clusters. Only rendered once the deck reported its slide count AND
            at least one struggle signal exists, so it adds no dead chrome. */}
        {role === "presenter" && deck.total > 0 && pulseSlides.length > 0 && (
          <div style={heatStripWrap}>
            <PulseHeatStrip slides={pulseSlides} total={deck.total} currentIndex={deck.index} variant="light" />
          </div>
        )}
      </div>

      {chatOpen && (
        <LiveChat
          slug={slug}
          slideIndex={deck.index}
          slideLabel={deck.label}
          name={chatName}
          onClose={() => setChatOpen(false)}
        />
      )}

      {showGate && <NameGate onSubmit={saveName} />}
    </div>
  );
}

// ---- shared chip / button primitives (light palette) ------------------------

function glassChip(): React.CSSProperties {
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

function pill(bg: string, fg: string): React.CSSProperties {
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

function FullscreenButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      aria-label={active ? "Exit fullscreen" : "Enter fullscreen"}
      title={active ? "Exit fullscreen" : "Fullscreen"}
      style={{ ...glassChip(), width: 34, padding: 0, justifyContent: "center", cursor: "pointer", fontSize: 15, lineHeight: 1 }}
    >
      {active ? "✕" : "⛶"}
    </button>
  );
}

function ChatButton({ open, onClick }: { open: boolean; onClick: () => void }) {
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

function QnaButton({ open, count, onClick }: { open: boolean; count: number; onClick: () => void }) {
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

function FollowToggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      title={on ? "Following the presenter — click to explore on your own" : "Explore mode — click to follow the presenter"}
      style={{ ...pill(on ? "#2C2A31" : "rgba(255,255,255,0.62)", on ? "#F4F2EC" : "#2C2A31"), border: on ? "none" : "1px solid rgba(255,255,255,0.85)", gap: 8 }}
    >
      <span style={{ width: 26, height: 15, borderRadius: 999, background: on ? "#BFE048" : "rgba(60,55,45,0.25)", position: "relative", transition: "background .16s", flex: "0 0 auto" }}>
        <span style={{ position: "absolute", top: 2, left: on ? 13 : 2, width: 11, height: 11, borderRadius: "50%", background: "#fff", transition: "left .16s", boxShadow: "0 1px 3px rgba(0,0,0,.28)" }} />
      </span>
      Auto-follow
    </button>
  );
}

// A compact reaction row (#2). Each tap fires one signal, pulses, and starts a ~3s
// local cooldown (the server also rate-limits). "I'm lost" is styled to stand out.
function ReactionBar({ onSend }: { onSend: (kind: SignalKind) => void }) {
  const [cooling, setCooling] = useState<Record<string, boolean>>({});
  const [pulse, setPulse] = useState<SignalKind | null>(null);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  const tap = (kind: SignalKind) => {
    if (cooling[kind]) return;
    onSend(kind);
    setPulse(kind);
    setCooling((c) => ({ ...c, [kind]: true }));
    timers.current.push(
      window.setTimeout(() => setPulse((p) => (p === kind ? null : p)), 420),
      window.setTimeout(() => setCooling((c) => ({ ...c, [kind]: false })), 3000),
    );
  };

  return (
    <div style={{ ...glassChip(), gap: 3, padding: "0 6px" }} role="group" aria-label="Send a reaction to the presenter">
      {REACTIONS.map((r) => (
        <button key={r.kind} onClick={() => tap(r.kind)} disabled={!!cooling[r.kind]} title={r.label} aria-label={r.label} style={reactionBtn(pulse === r.kind, !!cooling[r.kind])}>
          {r.emoji}
        </button>
      ))}
      <button onClick={() => tap("lost")} disabled={!!cooling.lost} title="I'm lost — let the presenter know" aria-label="I'm lost" style={lostBtn(pulse === "lost", !!cooling.lost)}>
        😕 I&rsquo;m lost
      </button>
    </div>
  );
}

function reactionBtn(pulsing: boolean, disabled: boolean): React.CSSProperties {
  return {
    width: 30,
    height: 30,
    borderRadius: 9,
    border: "none",
    background: pulsing ? "rgba(191,224,72,0.55)" : "transparent",
    cursor: disabled ? "default" : "pointer",
    fontSize: 16,
    lineHeight: 1,
    padding: 0,
    opacity: disabled && !pulsing ? 0.4 : 1,
    transform: pulsing ? "scale(1.28)" : "scale(1)",
    transition: "transform .18s ease, background .18s ease, opacity .18s ease",
  };
}

function lostBtn(pulsing: boolean, disabled: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    height: 26,
    padding: "0 10px",
    borderRadius: 8,
    border: "1px solid rgba(210,120,40,0.5)",
    background: pulsing ? "#E07B39" : "rgba(224,123,57,0.16)",
    color: pulsing ? "#fff" : "#9A4B12",
    fontFamily: '"Outfit", system-ui, sans-serif',
    fontSize: 12,
    fontWeight: 600,
    cursor: disabled ? "default" : "pointer",
    opacity: disabled && !pulsing ? 0.55 : 1,
    transform: pulsing ? "scale(1.06)" : "scale(1)",
    transition: "transform .18s ease, background .18s ease, opacity .18s ease",
    whiteSpace: "nowrap",
  };
}

// The name gate (#1/#3/#5): only shown when a name-required action needs one.
function NameGate({ onSubmit }: { onSubmit: (name: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "rgba(236,234,227,0.72)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(value);
        }}
        style={{
          width: "min(380px, 100%)",
          display: "flex",
          flexDirection: "column",
          gap: 14,
          padding: "30px 30px 26px",
          borderRadius: 22,
          background: "rgba(255,255,255,0.7)",
          border: "1px solid rgba(255,255,255,0.85)",
          boxShadow: "0 24px 60px -30px rgba(60,55,45,0.55)",
          fontFamily: '"Outfit", system-ui, sans-serif',
        }}
      >
        <div style={{ fontSize: 20, fontWeight: 500, color: "#262229", letterSpacing: "-0.01em" }}>Join the session</div>
        <div style={{ fontSize: 13.5, fontWeight: 300, color: "#6E6A62", lineHeight: 1.5 }}>
          What should we call you? Your name appears when you ask a question or vote.
        </div>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Your name"
          autoFocus
          maxLength={40}
          style={{ height: 46, padding: "0 14px", borderRadius: 12, border: "1px solid rgba(60,55,45,0.18)", background: "rgba(255,255,255,0.8)", fontFamily: "inherit", fontSize: 15, color: "#2C2A31", outline: "none" }}
        />
        <button
          type="submit"
          disabled={!value.trim()}
          style={{ height: 46, borderRadius: 12, border: "none", background: value.trim() ? "#2C2A31" : "#B7B2A8", color: "#F4F2EC", fontFamily: "inherit", fontSize: 15, fontWeight: 500, cursor: value.trim() ? "pointer" : "default" }}
        >
          Join the room
        </button>
      </form>
    </div>
  );
}

// ---- viewer poll card (#3) — ported verbatim from LiveDeck --------------------

function PollCard({
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
                <div style={{ ...pollResultBar(correct, mine), width: `${pct}%`, transition: reduceMotion ? "none" : "width .45s ease" }} aria-hidden />
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

const pollBadge: React.CSSProperties = {
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

const pollNote: React.CSSProperties = { fontSize: 11.5, fontWeight: 500, color: "#6E6A62", whiteSpace: "nowrap" };

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

const pollNameBtn: React.CSSProperties = {
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

const pollResultRow: React.CSSProperties = {
  position: "relative",
  borderRadius: 11,
  overflow: "hidden",
  background: "rgba(60,55,45,0.07)",
  padding: "10px 12px",
};

function pollResultBar(correct: boolean, mine: boolean): React.CSSProperties {
  return {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: 11,
    background: correct ? "rgba(120,176,54,0.34)" : mine ? "rgba(44,42,49,0.16)" : "rgba(120,116,108,0.16)",
  };
}

const pollResultText: React.CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 13,
  fontWeight: 500,
  color: "#2C2A31",
};

function pollTag(color: string): React.CSSProperties {
  return { fontSize: 9.5, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color, whiteSpace: "nowrap", flex: "0 0 auto" };
}

// ---- viewer Q&A queue panel (#5) — ported verbatim from LiveDeck --------------

function QnaPanel({
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
                <button onClick={() => (hasName ? onUpvote(q.id) : onNeedName())} disabled={voted} aria-pressed={voted} title={voted ? "You upvoted this" : "Upvote this question"} style={qnaVoteBtn(voted)}>
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

const qnaList: React.CSSProperties = { flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 };

const qnaItem: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
  padding: "10px 11px",
  borderRadius: 12,
  background: "rgba(255,255,255,0.6)",
  border: "1px solid rgba(60,55,45,0.1)",
};

const qnaEmpty: React.CSSProperties = { fontSize: 12.5, color: "#6E6A62", padding: "10px 2px" };

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

const qnaErrorText: React.CSSProperties = { fontSize: 12, color: "#B5331F", fontWeight: 500 };

const qnaCloseBtn: React.CSSProperties = {
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

// ---- presenter presence roster (#1) — light adaptation of PresenterConsole ----

function PresenceChip({
  watching,
  following,
  exploring,
  behind,
  viewers,
  open,
  onOpenChange,
}: {
  watching: number;
  following: number;
  exploring: number;
  behind: number;
  viewers: Viewer[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onOpenChange(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onOpenChange]);

  return (
    <span ref={wrapRef} style={{ position: "relative", display: "inline-flex" }}>
      <button onClick={() => onOpenChange(!open)} title="Show who's watching" aria-expanded={open} style={{ ...glassChip(), cursor: "pointer", gap: 5 }}>
        👁 {watching} watching
        {watching > 0 && (
          <span style={{ color: "#6E6A62", fontWeight: 400 }}>
            {" · "}
            {following} following · {exploring} exploring · {behind} behind
          </span>
        )}
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 10px)",
            right: 0,
            zIndex: 60,
            minWidth: 230,
            maxHeight: 320,
            overflowY: "auto",
            padding: "10px 12px",
            borderRadius: 14,
            background: "rgba(255,255,255,0.92)",
            border: "1px solid rgba(255,255,255,0.85)",
            backdropFilter: "blur(16px)",
            WebkitBackdropFilter: "blur(16px)",
            boxShadow: "0 22px 55px -28px rgba(60,55,45,0.6)",
            display: "flex",
            flexDirection: "column",
            gap: 6,
            fontFamily: '"Outfit", system-ui, sans-serif',
          }}
        >
          {viewers.length === 0 ? (
            <div style={{ color: "#6E6A62", fontSize: 12 }}>No one watching yet.</div>
          ) : (
            viewers.map((v, i) => (
              <div key={`${v.name}-${i}`} style={{ display: "flex", justifyContent: "space-between", gap: 14, fontSize: 12.5, color: "#2C2A31" }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.name}</span>
                <span style={{ color: "#6E6A62", whiteSpace: "nowrap" }}>
                  slide {v.index + 1}
                  {v.follow ? " · following" : ""}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </span>
  );
}

// Persistent "help" meter (#2): decaying counts of viewers who feel lost / want you
// to slow down. Amber/red so it catches the eye; hidden when both are 0.
// Renders inline chips — the caller owns positioning (the top-left presenter
// cluster, shared with the comprehension-check buttons).
function HelpMeter({ lost, slow }: { lost: number; slow: number }) {
  if (lost <= 0 && slow <= 0) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {lost > 0 && (
        <span style={helpChip("#9A2A15", "rgba(181,51,31,0.16)", "rgba(181,51,31,0.45)")}>
          ❓ {lost} feel{lost === 1 ? "s" : ""} lost
        </span>
      )}
      {slow > 0 && (
        <span style={helpChip("#9A4B12", "rgba(224,123,57,0.18)", "rgba(210,120,40,0.5)")}>
          🐢 {slow} want{slow === 1 ? "s" : ""} you to slow down
        </span>
      )}
    </div>
  );
}

function helpChip(fg: string, bg: string, border: string): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    height: 30,
    padding: "0 12px",
    borderRadius: 999,
    background: bg,
    color: fg,
    border: `1px solid ${border}`,
    fontFamily: '"Outfit", system-ui, sans-serif',
    fontSize: 12.5,
    fontWeight: 600,
    whiteSpace: "nowrap",
    backdropFilter: "blur(14px)",
    WebkitBackdropFilter: "blur(14px)",
    boxShadow: "0 6px 18px -12px rgba(60,55,45,0.4)",
  };
}

// Comprehension checkpoint: two one-tap fixes that appear next to the help meter
// when the "I'm lost" count crosses LOST_THRESHOLD — broadcast an AI recap of the
// current slide to every viewer, or draft an AI knowledge-check for review.
// "Clear recap" stays visible while a recap is live, even after the meter decays.
function ComprehensionCheck({
  show,
  recapActive,
  sending,
  error,
  pollLive,
  onSendRecap,
  onClearRecap,
  onLaunchCheck,
}: {
  show: boolean;
  recapActive: boolean;
  sending: boolean;
  error: string | null;
  pollLive: boolean;
  onSendRecap: () => void;
  onClearRecap: () => void;
  onLaunchCheck: () => void;
}) {
  if (!show && !recapActive) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      {show && (
        <button
          onClick={onSendRecap}
          disabled={sending || recapActive}
          style={checkBtn(sending || recapActive)}
          title={recapActive ? "A recap is already live" : "Broadcast an AI recap of this slide to every viewer"}
        >
          {sending ? "Sending…" : "📢 Send recap"}
        </button>
      )}
      {show && (
        <button
          onClick={onLaunchCheck}
          disabled={pollLive}
          style={checkBtn(pollLive)}
          title={pollLive ? "A poll is already live" : "Draft an AI knowledge-check on this slide for review"}
        >
          ✨ Launch check
        </button>
      )}
      {recapActive && (
        <button onClick={onClearRecap} style={checkBtn(false)} title="Remove the recap overlay from every viewer">
          Clear recap
        </button>
      )}
      {error && <span style={{ ...glassChip(), color: "#B5331F", fontSize: 11.5 }}>{error}</span>}
    </div>
  );
}

function checkBtn(muted: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    height: 30,
    padding: "0 12px",
    borderRadius: 999,
    border: "1px solid rgba(154,42,21,0.35)",
    background: "rgba(255,255,255,0.72)",
    color: "#9A2A15",
    cursor: muted ? "default" : "pointer",
    fontFamily: '"Outfit", system-ui, sans-serif',
    fontSize: 12.5,
    fontWeight: 600,
    whiteSpace: "nowrap",
    backdropFilter: "blur(14px)",
    WebkitBackdropFilter: "blur(14px)",
    boxShadow: "0 6px 18px -12px rgba(60,55,45,0.4)",
    opacity: muted ? 0.6 : 1,
  };
}

function mapRecapError(code?: string): string {
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

// The viewer's recap card (comprehension checkpoint): the presenter pushed a short
// AI recap of the slide because part of the room felt lost. Purely informational —
// one dismiss button, no inputs. Dismissal is local to this viewer. Rendered in
// PARENT app-chrome only; nothing is ever posted into the sandboxed deck frame.
function RecapCard({ recap, onDismiss }: { recap: Recap; onDismiss: () => void }) {
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
const recapCardWrap: React.CSSProperties = {
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

// The shared bottom-center column for the recap + catch-up cards: clears the
// poll card (bottom-left) and the Q&A panel (right), and stacks the two cards
// on the rare occasion both are open.
const centerCardStack: React.CSSProperties = {
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

const recapDismissBtn: React.CSSProperties = {
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

// Map an /api/catchup error code to a friendly line for the card body.
function mapCatchUpError(code?: string): string {
  switch (code) {
    case "rate_limited":
      return "You're doing that quickly — give it a few seconds.";
    case "ai_budget_exceeded":
      return "The AI is at today's usage limit — ask the presenter.";
    case "no_content":
      return "Those slides have no notes to recap yet.";
    case "ai_not_configured":
      return "AI isn't configured yet — ask the presenter.";
    case "timeout":
      return "That took too long — try again.";
    default:
      return "Couldn't catch you up — try again.";
  }
}

// This viewer's personal catch-up card: an on-demand AI recap of the slides
// between where they are and the live slide. Local to this tab (nothing is
// broadcast); dismissing aborts any in-flight fetch and clears local state.
// Rendered in PARENT app-chrome only — never posted into the sandboxed frame.
function CatchUpCard({ catchUp, onDismiss }: { catchUp: CatchUp; onDismiss: () => void }) {
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

// Re-render every `stepMs` so a client-side countdown ticks. Returns "now".
function useNow(stepMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), stepMs);
    return () => window.clearInterval(id);
  }, [stepMs]);
  return now;
}

// The viewer's Turn & Talk card: the presenter broadcast a discussion/exercise
// prompt with a synchronized countdown. The MM:SS timer renders client-side from
// `endsAt` (everyone counts down to the same wall-clock instant); when it hits 0
// it lingers briefly as "time's up", and the presenter's Regroup clears it
// everywhere via the session poll. Hiding is local; a new activity id re-shows.
// Rendered in PARENT app-chrome only — never posted into the sandboxed frame.
function ActivityCard({ activity, onHide }: { activity: Activity; onHide: () => void }) {
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

function floatStyle(left: number): React.CSSProperties {
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

const reactionBadge: React.CSSProperties = {
  position: "absolute",
  top: 12,
  left: 12,
  padding: "4px 11px",
  borderRadius: 999,
  background: "#2C2A31",
  color: "#F4F2EC",
  fontSize: 12,
  fontWeight: 700,
};

// ---- presenter poll panel (#3/#4) — light adaptation of PresenterConsole ------

// The tally's winning option (first wins a tie) — the branch the room chose.
function winningIndex(tally: number[], optionCount: number): number {
  let win = 0;
  for (let i = 1; i < optionCount; i++) {
    if ((tally[i] ?? 0) > (tally[win] ?? 0)) win = i;
  }
  return win;
}

function PresenterPollPanel({
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
  const [routeBusy, setRouteBusy] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
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

  async function route(i: number) {
    if (routeBusy) return;
    setRouteBusy(true);
    setRouteError(null);
    const ok = await onRoute(i);
    setRouteBusy(false);
    if (!ok) setRouteError("Couldn't route — only the presenter with the clicker can move the room.");
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
        typeof data.correctIndex === "number" && data.correctIndex >= 0 && data.correctIndex < opts.length ? data.correctIndex : null,
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

  // Drop empty options and remap the correct index to the kept list.
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

  const max = Math.max(1, ...(tally.length ? tally : [0]));
  const isBranch = poll?.kind === "branch";
  const taken = poll && isBranch && typeof poll.takenIndex === "number" ? poll.takenIndex : null;
  const win = poll ? winningIndex(tally, poll.options.length) : 0;

  return (
    <div style={presenterPollWrap}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <span style={pollBadge}>{poll ? (isBranch ? "⑂ Branch vote" : "Live poll") : "New poll"}</span>
        <button onClick={onDismiss} title="Hide panel" aria-label="Hide poll panel" style={qnaCloseBtn}>
          ✕
        </button>
      </div>

      {poll ? (
        <div style={presenterPanelScroll}>
          <div style={{ fontSize: 15, fontWeight: 500, color: "#262229", lineHeight: 1.4 }}>{poll.question}</div>
          <div style={{ fontSize: 12, fontWeight: 500, color: poll.revealed ? "#4B5A16" : "#6E6A62" }}>
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
                <div key={i} style={pollResultRow}>
                  <div style={{ ...pollResultBar(poll.revealed && correct, false), width: `${pct}%`, transition: reduceMotion ? "none" : "width .45s ease" }} aria-hidden />
                  <div style={pollResultText}>
                    <span style={{ flex: 1, display: "inline-flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{opt}</span>
                      {range && (
                        <span style={{ fontSize: 10.5, color: "#8A867E", whiteSpace: "nowrap", flex: "0 0 auto" }}>
                          slides {range.from + 1}–{range.to + 1}
                        </span>
                      )}
                      {poll.revealed && correct && <span style={pollTag("#3F7A12")}>{isBranch ? "⑂ taken" : "✓ correct"}</span>}
                    </span>
                    <span style={{ fontWeight: 600, color: "#3A372F", flex: "0 0 auto" }}>
                      {count}
                      {total > 0 ? ` · ${share}%` : ""}
                    </span>
                    {/* Untaken branches remain reachable — route to ANY path. */}
                    {isBranch && poll.revealed && taken !== i && (
                      <button
                        onClick={() => void route(i)}
                        disabled={routeBusy}
                        title={`Take the room to slides ${(poll.branches?.[i]?.from ?? 0) + 1}–${(poll.branches?.[i]?.to ?? 0) + 1}`}
                        style={{ ...qnaActionBtn, height: 26, fontSize: 11.5, flex: "0 0 auto", opacity: routeBusy ? 0.6 : 1 }}
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
              the draft rationale above. */}
          {poll.revealed && poll.explanation && <div style={pollExplain}>{poll.explanation}</div>}
          {isBranch && poll.revealed && taken !== null && (
            <div style={pollExplain}>
              ⑂ Routed the room to <strong style={{ fontWeight: 600 }}>{poll.options[taken]}</strong>
              {poll.branches?.[taken] ? ` (slides ${poll.branches[taken].from + 1}–${poll.branches[taken].to + 1})` : ""}.
              Untaken paths stay reachable — Go → any of them, or navigate freely.
            </div>
          )}
          {routeError && <div style={qnaErrorText}>{routeError}</div>}
          <div style={{ display: "flex", gap: 10, marginTop: 2 }}>
            {!poll.revealed && (
              <button onClick={onReveal} style={{ ...pill("#2C2A31", "#F4F2EC"), flex: 1, height: 40, justifyContent: "center" }}>
                {isBranch ? "Reveal the room's choice" : "Reveal to room"}
              </button>
            )}
            {isBranch && poll.revealed && taken === null && (
              <button
                onClick={() => void route(win)}
                disabled={routeBusy}
                style={{ ...pill("#2C2A31", "#F4F2EC"), flex: 1, height: 40, justifyContent: "center", opacity: routeBusy ? 0.7 : 1 }}
              >
                {routeBusy ? "Routing…" : `⑂ Go to winning branch — ${poll.options[win] ?? ""}`}
              </button>
            )}
            <button onClick={onClose} style={{ ...pill("rgba(255,255,255,0.62)", "#2C2A31"), border: "1px solid rgba(255,255,255,0.85)", flex: poll.revealed && !(isBranch && taken === null) ? 1 : "0 0 auto", height: 40, justifyContent: "center" }}>
              Close
            </button>
          </div>
        </div>
      ) : (
        <div style={presenterPanelScroll}>
          {/* Branch point: this slide's authored paths — one tap opens the vote. */}
          {branches && (
            <div style={branchOffer}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: "#4B5A16" }}>
                ⑂ This slide is a branch point
              </div>
              {branches.map((b, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12, color: "#4A463E" }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.label}</span>
                  <span style={{ color: "#8A867E", whiteSpace: "nowrap" }}>
                    slides {b.from + 1}–{b.to + 1}
                  </span>
                </div>
              ))}
              <button onClick={() => void openBranch()} disabled={branchBusy} style={draftBtn(branchBusy)}>
                {branchBusy ? "Opening…" : "⑂ Open branch vote"}
              </button>
              {branchError && <div style={qnaErrorText}>{branchError}</div>}
            </div>
          )}
          <button onClick={() => void draft()} disabled={draftLoading} style={draftBtn(draftLoading)}>
            {draftLoading ? "Drafting…" : "✨ Draft with AI"}
          </button>
          {draftError && <div style={qnaErrorText}>{draftError}</div>}
          {explanation && <div style={pollExplain}>{explanation}</div>}

          <div>
            <FieldLabel>Question</FieldLabel>
            <textarea value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask the room…" maxLength={400} rows={2} style={lightTextarea} />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <FieldLabel>Options · mark the correct one (optional)</FieldLabel>
            {options.map((opt, i) => {
              const removable = options.length > 2;
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button type="button" onClick={() => toggleCorrect(i)} title={correctIndex === i ? "Correct answer — click to unset" : "Mark as the correct answer"} aria-pressed={correctIndex === i} aria-label={`Mark option ${i + 1} correct`} style={correctDot(correctIndex === i)} />
                  <input value={opt} onChange={(e) => setOptionAt(i, e.target.value)} placeholder={`Option ${i + 1}`} maxLength={200} style={lightInput} />
                  <button type="button" onClick={() => removeOption(i)} disabled={!removable} title="Remove option" aria-label={`Remove option ${i + 1}`} style={{ ...qnaCloseBtn, opacity: removable ? 1 : 0.35, cursor: removable ? "pointer" : "default" }}>
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

          {launchError && <div style={qnaErrorText}>{launchError}</div>}
          <button onClick={() => void launch()} disabled={!canLaunch} style={{ ...pill(canLaunch ? "#2C2A31" : "#B7B2A8", "#F4F2EC"), height: 42, justifyContent: "center", cursor: canLaunch ? "pointer" : "default" }}>
            {launching ? "Launching…" : "Launch poll"}
          </button>
        </div>
      )}
    </div>
  );
}

// ---- presenter Turn & Talk panel — light adaptation of PresenterConsole -------

// Turn & Talk duration presets — synchronized countdowns, so no free-form input.
const ACTIVITY_PRESETS: { label: string; sec: number }[] = [
  { label: "2 min", sec: 120 },
  { label: "5 min", sec: 300 },
  { label: "10 min", sec: 600 },
];

// No active activity → the compose form (prompt + duration presets + optional
// follow-up). Active → the prompt, a live MM:SS countdown (client-side from
// endsAt) and the Regroup button, which ends the activity on every screen at
// once (and, for a "poll" follow-up, opens the reviewed ✨ poll-draft flow —
// handled by the parent). Compose state is local; the parent owns the live
// activity (it rides the session poll).
function PresenterActivityPanel({
  activity,
  onStart,
  onRegroup,
  onDismiss,
}: {
  activity: Activity | null;
  onStart: (prompt: string, durationSec: number, followUp: ActivityFollowUp | null) => Promise<boolean>;
  onRegroup: () => void;
  onDismiss: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [durationSec, setDurationSec] = useState(300);
  const [followUp, setFollowUp] = useState<ActivityFollowUp | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(500);

  // When an activity ends/clears, reset the compose form for the next one
  // (mirrors the poll panel's blank-slate reset).
  const hadActivityRef = useRef(false);
  useEffect(() => {
    if (activity) {
      hadActivityRef.current = true;
      return;
    }
    if (hadActivityRef.current) {
      hadActivityRef.current = false;
      setPrompt("");
      setFollowUp(null);
      setError(null);
    }
  }, [activity]);

  const canStart = prompt.trim().length > 0 && !starting;
  async function start() {
    if (!canStart) return;
    setStarting(true);
    setError(null);
    const ok = await onStart(prompt.trim(), durationSec, followUp);
    setStarting(false);
    if (!ok) setError("Couldn't start — try again.");
  }

  const remaining = activity ? activity.endsAt - now : 0;
  const done = remaining <= 0;
  const secs = Math.max(0, Math.ceil(remaining / 1000));
  const mm = String(Math.floor(secs / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");

  return (
    <div style={presenterPollWrap}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <span style={pollBadge}>⏱ Turn &amp; talk</span>
        <button onClick={onDismiss} title="Hide panel" aria-label="Hide Turn & Talk panel" style={qnaCloseBtn}>
          ✕
        </button>
      </div>

      {activity ? (
        <div style={presenterPanelScroll}>
          <div style={{ fontSize: 15, fontWeight: 500, color: "#262229", lineHeight: 1.45, whiteSpace: "pre-wrap" }}>
            {activity.prompt}
          </div>
          <div style={presenterCountdown(done)}>{done ? "Time's up" : `${mm}:${ss}`}</div>
          <div style={{ fontSize: 12, fontWeight: 500, color: done ? "#9A4B12" : "#6E6A62" }}>
            {done
              ? "The room sees “time's up” — regroup to clear it."
              : "Live on every viewer's screen — everyone counts down together."}
          </div>
          {activity.followUp === "poll" && (
            <div style={pollExplain}>Regrouping opens an AI poll draft on this slide for your review.</div>
          )}
          {activity.followUp === "pinboard" && (
            <div style={pollExplain}>Viewers see a nudge to share their link on the pinboard afterwards.</div>
          )}
          <button
            onClick={onRegroup}
            style={{ ...pill("#2C2A31", "#F4F2EC"), height: 42, justifyContent: "center" }}
            title="End the activity on every screen at once"
          >
            {activity.followUp === "poll" ? "⏹ Regroup & draft poll" : "⏹ Regroup"}
          </button>
        </div>
      ) : (
        <div style={presenterPanelScroll}>
          <div>
            <FieldLabel>Prompt</FieldLabel>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Discuss with your neighbor…"
              maxLength={500}
              rows={3}
              style={lightTextarea}
            />
          </div>

          <div>
            <FieldLabel>Duration</FieldLabel>
            <div style={{ display: "flex", gap: 8 }}>
              {ACTIVITY_PRESETS.map((p) => (
                <button
                  key={p.sec}
                  type="button"
                  onClick={() => setDurationSec(p.sec)}
                  aria-pressed={durationSec === p.sec}
                  style={activityChoice(durationSec === p.sec)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <FieldLabel>Afterwards (optional)</FieldLabel>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={() => setFollowUp(null)} aria-pressed={followUp === null} style={activityChoice(followUp === null)}>
                Nothing
              </button>
              <button type="button" onClick={() => setFollowUp("poll")} aria-pressed={followUp === "poll"} style={activityChoice(followUp === "poll")}>
                📊 Poll
              </button>
              <button type="button" onClick={() => setFollowUp("pinboard")} aria-pressed={followUp === "pinboard"} style={activityChoice(followUp === "pinboard")}>
                📌 Pinboard
              </button>
            </div>
          </div>

          {error && <div style={qnaErrorText}>{error}</div>}
          <button
            onClick={() => void start()}
            disabled={!canStart}
            style={{ ...pill(canStart ? "#2C2A31" : "#B7B2A8", "#F4F2EC"), height: 42, justifyContent: "center", cursor: canStart ? "pointer" : "default" }}
          >
            {starting ? "Starting…" : "⏱ Start Turn & Talk"}
          </button>
        </div>
      )}
    </div>
  );
}

function presenterCountdown(done: boolean): React.CSSProperties {
  return {
    fontVariantNumeric: "tabular-nums",
    fontSize: done ? 22 : 42,
    fontWeight: 600,
    letterSpacing: done ? "0" : "0.03em",
    lineHeight: 1.1,
    color: done ? "#9A4B12" : "#2C2A31",
  };
}

function activityChoice(on: boolean): React.CSSProperties {
  return {
    flex: 1,
    height: 34,
    borderRadius: 9,
    border: on ? "1px solid #2C2A31" : "1px solid rgba(60,55,45,0.18)",
    background: on ? "#2C2A31" : "rgba(255,255,255,0.7)",
    color: on ? "#F4F2EC" : "#2C2A31",
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: 12.5,
    fontWeight: 600,
    whiteSpace: "nowrap",
  };
}

// ---- presenter Q&A panel (#5) — light adaptation of PresenterConsole ----------

interface AiAnswerState {
  loading: boolean;
  open: boolean;
  answer?: string;
  error?: string;
}

function PresenterQnaPanel({
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

  useEffect(
    () => () => {
      Object.values(aiCtrlsRef.current).forEach((c) => c.abort());
      digestCtrlRef.current?.abort();
    },
    [],
  );

  async function aiAnswer(qid: string, questionText: string) {
    aiCtrlsRef.current[qid]?.abort();
    const ctrl = new AbortController();
    aiCtrlsRef.current[qid] = ctrl;
    setAi((m) => ({ ...m, [qid]: { loading: true, open: true } }));
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, name: "presenter", question: questionText, slideIndex: indexRef.current, stream: false }),
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

  const toggleAi = (qid: string) => setAi((m) => (m[qid] ? { ...m, [qid]: { ...m[qid], open: !m[qid].open } } : m));

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
    <div style={presenterQnaWrap}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <span style={pollBadge}>Questions</span>
        <button onClick={onDismiss} title="Hide panel" aria-label="Hide questions panel" style={qnaCloseBtn}>
          ✕
        </button>
      </div>

      {/* AI confusion digest */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <button onClick={() => void runDigest()} disabled={digestLoading} style={draftBtn(digestLoading)}>
          {digestLoading ? "Summarizing…" : "✨ Summarize confusion"}
        </button>
        {digestError && <div style={qnaErrorText}>{digestError}</div>}
        {themes &&
          (themes.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 11.5, color: "#6E6A62" }}>The room is stuck on:</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {themes.map((t, i) => (
                  <span key={i} style={digestChip}>
                    {t}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "#8A867E" }}>Not enough questions yet.</div>
          ))}
      </div>

      {/* the queue */}
      <div style={presenterPanelScroll}>
        {questions.length === 0 ? (
          <div style={{ fontSize: 13, color: "#8A867E" }}>No questions from the room yet.</div>
        ) : (
          questions.map((q) => {
            const a = ai[q.id];
            const hasDraft = !!(a && (a.answer || a.error));
            return (
              <div key={q.id} style={qnaRow(q.dismissed)}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                  <div style={qnaVotes}>
                    <span style={{ fontSize: 15, fontWeight: 700, lineHeight: 1, color: "#2C2A31" }}>{q.votes}</span>
                    <span style={{ fontSize: 8.5, color: "#6E6A62", textTransform: "uppercase", letterSpacing: "0.06em" }}>votes</span>
                  </div>
                  <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 5 }}>
                    <div style={{ fontSize: 13.5, color: q.dismissed ? "#8A867E" : "#2C2A31", lineHeight: 1.4 }}>{q.text}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, color: "#6E6A62", flexWrap: "wrap", minWidth: 0 }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 130 }}>{q.name}</span>
                      {q.answered && <span style={qnaStateTag("#3F7A12")}>✓ answered</span>}
                      {q.dismissed && <span style={qnaStateTag("#8A867E")}>dismissed</span>}
                    </div>

                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 2 }}>
                      {!q.dismissed && (
                        <button onClick={() => onAction("answer", q.id)} style={qnaActionBtn} title={q.answered ? "Already answered — click to re-mark" : "Mark as answered"}>
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
                          <span style={{ color: "#6E6A62", fontSize: 12.5 }}>Drafting an answer…</span>
                        ) : a.error ? (
                          <span style={qnaErrorText}>{a.error}</span>
                        ) : (
                          <div style={{ fontSize: 12.5, lineHeight: 1.55, color: "#3A372F", whiteSpace: "pre-wrap" }}>{a.answer}</div>
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

// ---- presenter panel shared styles + helpers (light) --------------------------

const presenterPollWrap: React.CSSProperties = {
  position: "absolute",
  left: 16,
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

// The presenter heat strip's floating dock (Insight Engine): a slim glass bar
// across the bottom of the stage — clears the poll card (bottom-left card is
// viewer-only) and the top control clusters. Tooltips need hover, so pointer
// events stay ON (it's a 20px-tall bar; the deck below keeps its full surface).
const heatStripWrap: React.CSSProperties = {
  position: "absolute",
  left: 16,
  right: 16,
  bottom: 10,
  zIndex: 37,
  display: "flex",
  alignItems: "center",
  padding: "5px 8px",
  borderRadius: 10,
  background: "rgba(255,255,255,0.72)",
  border: "1px solid rgba(255,255,255,0.85)",
  backdropFilter: "blur(12px)",
  WebkitBackdropFilter: "blur(12px)",
};

const presenterQnaWrap: React.CSSProperties = {
  ...presenterPollWrap,
  left: "auto",
  right: 16,
  width: "min(380px, calc(100% - 32px))",
};

const presenterPanelScroll: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "#6E6A62", marginBottom: 6 }}>{children}</div>;
}

const lightInput: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 36,
  padding: "0 11px",
  borderRadius: 9,
  border: "1px solid rgba(60,55,45,0.18)",
  background: "rgba(255,255,255,0.85)",
  color: "#2C2A31",
  fontFamily: "inherit",
  fontSize: 13,
  outline: "none",
};

const lightTextarea: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "9px 11px",
  borderRadius: 9,
  resize: "vertical",
  border: "1px solid rgba(60,55,45,0.18)",
  background: "rgba(255,255,255,0.85)",
  color: "#2C2A31",
  fontFamily: "inherit",
  fontSize: 13.5,
  lineHeight: 1.4,
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
    border: on ? "6px solid #BFE048" : "2px solid rgba(60,55,45,0.3)",
    background: on ? "#2C2A31" : "transparent",
  };
}

const addOptionBtn: React.CSSProperties = {
  height: 34,
  borderRadius: 9,
  border: "1px dashed rgba(60,55,45,0.28)",
  background: "transparent",
  color: "#6E6A62",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 12.5,
  fontWeight: 500,
};

function draftBtn(loading: boolean): React.CSSProperties {
  return {
    height: 40,
    borderRadius: 11,
    border: "1px solid rgba(120,150,30,0.45)",
    background: loading ? "rgba(191,224,72,0.18)" : "rgba(191,224,72,0.3)",
    color: "#4B5A16",
    cursor: loading ? "default" : "pointer",
    fontFamily: "inherit",
    fontSize: 13.5,
    fontWeight: 600,
    opacity: loading ? 0.8 : 1,
  };
}

const pollExplain: React.CSSProperties = {
  fontSize: 12,
  color: "#6E6A62",
  lineHeight: 1.5,
  fontStyle: "italic",
  padding: "8px 10px",
  borderRadius: 9,
  background: "rgba(60,55,45,0.05)",
  border: "1px solid rgba(60,55,45,0.1)",
};

// The branch-point offer in the compose panel (this slide's authored paths).
const branchOffer: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: "10px 12px",
  borderRadius: 11,
  background: "rgba(191,224,72,0.14)",
  border: "1px solid rgba(120,150,30,0.35)",
};

const digestChip: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#4B5A16",
  background: "rgba(191,224,72,0.24)",
  border: "1px solid rgba(120,150,30,0.4)",
  borderRadius: 999,
  padding: "5px 11px",
  lineHeight: 1.35,
};

function qnaRow(dismissed: boolean): React.CSSProperties {
  return {
    borderRadius: 12,
    padding: "10px 11px",
    background: dismissed ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.62)",
    border: "1px solid rgba(60,55,45,0.12)",
    opacity: dismissed ? 0.7 : 1,
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
  borderRadius: 9,
  background: "rgba(60,55,45,0.06)",
};

function qnaStateTag(color: string): React.CSSProperties {
  return { fontSize: 9.5, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color, whiteSpace: "nowrap", flex: "0 0 auto" };
}

const qnaActionBtn: React.CSSProperties = {
  height: 28,
  padding: "0 10px",
  borderRadius: 8,
  border: "1px solid rgba(60,55,45,0.18)",
  background: "rgba(255,255,255,0.7)",
  color: "#2C2A31",
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
    border: "1px solid rgba(120,150,30,0.4)",
    background: "rgba(191,224,72,0.24)",
    color: "#4B5A16",
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
  borderRadius: 9,
  background: "rgba(60,55,45,0.05)",
  border: "1px solid rgba(60,55,45,0.1)",
};

function mapDraftError(code?: string): string {
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

function mapAskError(code?: string): string {
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
