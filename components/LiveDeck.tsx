"use client";

// The live workshop deck — wraps the pixel-exact design deck (an iframe running
// its own <deck-stage> engine + the bridge) and layers the app's multi-user
// control on top:
//
//   VIEWER  — names themselves, then follows the presenter. Auto-follow (default
//             on) pins them to the presenter's slide; turned off, they can page
//             back and forth but never past the highest slide the presenter has
//             shown (the "unlock" ceiling). A chat sidebar answers questions
//             grounded in the current slide.
//   PRESENTER — drives the session: every slide they show broadcasts to viewers
//             and unlocks up to there. "Reset lock" pins the ceiling to the
//             current slide. A presenter panel shows notes, the next slide, a
//             timer, and how far viewers are unlocked.
//
// State is shared through /api/session (Redis-backed) so it works across
// devices, not just one browser.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { LiveChat } from "./LiveChat";
import { createSyncChannel, type SyncChannel } from "@/lib/sync";
import { useFullscreen } from "@/lib/useFullscreen";

const POLL_MS = Number(process.env.NEXT_PUBLIC_SESSION_POLL_MS) || 2000;
// Back off when there's nothing to sync so an idle or backgrounded tab doesn't
// hammer Redis. The live experience is unchanged — these only apply when no
// presenter is live (viewer) or the tab is hidden.
const IDLE_POLL_MS = 10_000; // viewer, no presenter live
const HIDDEN_POLL_MS = 60_000; // tab in the background
const PRESENTER_POLL_MS = 5_000; // presenter: this poll is only a cross-device fallback
const NAME_KEY = "presentation:name";

// Q&A queue (#5): the viewer panel polls only while it's open, so a closed panel
// costs nothing. Slower cadence than the live session poll; near-dormant when hidden.
const QNA_POLL_MS = 5_000;
const QNA_HIDDEN_MS = 30_000;

// Viewer→presenter backchannel reaction kinds (#2). "lost" is rendered as its
// own distinct button; the rest ride in a compact icon row.
type SignalKind = "up" | "party" | "slow" | "hand" | "lost";
const REACTIONS: { kind: SignalKind; emoji: string; label: string }[] = [
  { kind: "up", emoji: "👍", label: "Nice" },
  { kind: "party", emoji: "🎉", label: "Celebrate" },
  { kind: "slow", emoji: "🐢", label: "Slow down" },
  { kind: "hand", emoji: "🙋", label: "Raise hand" },
];

type Role = "viewer" | "presenter";

interface DeckState {
  index: number;
  total: number;
  label: string;
  nextLabel: string;
  notes: string;
}
interface SessionState {
  index: number;
  max: number;
  // A presenter is actively presenting. When false, viewers browse freely
  // (no lock, no auto-follow); the sync only kicks in while someone's live.
  live: boolean;
}

// The viewer-safe projection of a live poll (#3), delivered on the SAME session
// poll. Pre-reveal: correctIndex/tally/total are null — viewers never see the
// answer or counts until the presenter reveals. `explanation` is the AI "why that
// answer" note, generated once per poll and attached shortly AFTER reveal (it
// arrives on a later session tick — the card just re-renders when it lands).
interface ViewerPoll {
  id: string;
  question: string;
  options: string[];
  revealed: boolean;
  correctIndex: number | null;
  tally: number[] | null;
  total: number | null;
  explanation: string | null;
  at: number;
}

// A presenter-broadcast recap of a slide (comprehension checkpoint), delivered on
// the same session poll. Dismiss is local per viewer; a new id shows again.
interface Recap {
  id: string;
  text: string;
  slideIndex: number;
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

// A question in the upvotable Q&A queue (#5). Viewers receive only non-dismissed
// entries, already sorted (votes desc, oldest-first).
interface QnaQuestion {
  id: string;
  name: string;
  text: string;
  votes: number;
  answered: boolean;
  dismissed: boolean;
  at: number;
}

export function LiveDeck({
  slug,
  embedUrl,
  role,
  title,
}: {
  slug: string;
  embedUrl: string;
  role: Role;
  title: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const { isFullscreen, toggle } = useFullscreen();

  const [name, setName] = useState<string | null>(null);
  const [showGate, setShowGate] = useState(role === "viewer");
  const [deck, setDeck] = useState<DeckState>({ index: 0, total: 0, label: "", nextLabel: "", notes: "" });
  const [session, setSession] = useState<SessionState>({ index: 0, max: 0, live: false });
  const [autoFollow, setAutoFollow] = useState(true);
  const [chatOpen, setChatOpen] = useState(false);
  const [controlsShown, setControlsShown] = useState(true);
  // Live headcount from the presence heartbeat (#1) — powers the "N watching" chip.
  const [watching, setWatching] = useState(0);
  // Live poll (#3): the presenter's current poll (or null), delivered on the
  // session poll. `myVote` tracks THIS viewer's own choice, keyed by poll id so it
  // resets the moment a new poll opens.
  const [poll, setPoll] = useState<ViewerPoll | null>(null);
  const [myVote, setMyVote] = useState<{ pollId: string; optionIndex: number } | null>(null);
  // Room recap (comprehension checkpoint): a presenter-broadcast overlay riding
  // the same session poll. Dismiss is local; a NEW recap id shows the card again.
  const [recap, setRecap] = useState<Recap | null>(null);
  const [dismissedRecapId, setDismissedRecapId] = useState<string | null>(null);
  // Personal catch-up card: fetched on demand while behind; dismiss clears it.
  const [catchUp, setCatchUp] = useState<CatchUp | null>(null);
  const [reduceMotion, setReduceMotion] = useState(false);
  // Q&A queue (#5): the toggleable question panel. `questions` is the (already-sorted)
  // non-dismissed queue; `myVotes` marks the qids this viewer has upvoted so the
  // button locks locally (the server is idempotent regardless).
  const [qnaOpen, setQnaOpen] = useState(false);
  const [questions, setQuestions] = useState<QnaQuestion[]>([]);
  const [myVotes, setMyVotes] = useState<Record<string, boolean>>({});

  // Refs so the (stable) message/poll handlers always read live values.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const autoFollowRef = useRef(autoFollow);
  autoFollowRef.current = autoFollow;
  const nameRef = useRef(name);
  nameRef.current = name;
  const deckRef = useRef(deck);
  deckRef.current = deck;
  const channelRef = useRef<SyncChannel | null>(null);
  // In-flight vote request — aborted when superseded by a newer tap or on unmount.
  const voteCtrlRef = useRef<AbortController | null>(null);
  // In-flight catch-up request — aborted when superseded, dismissed, or unmounted.
  const catchUpCtrlRef = useRef<AbortController | null>(null);

  const send = useCallback((msg: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage(msg, "*");
  }, []);

  // The free-roam bridge role: no clamp, no follow. Used for viewers when no
  // presenter is live.
  const sendFree = useCallback(() => {
    send({ type: "deck:role", role: "viewer", max: 1e9, locked: false });
  }, [send]);

  const pushRole = useCallback(() => {
    if (role === "presenter") {
      send({ type: "deck:role", role: "presenter" });
      return;
    }
    const s = sessionRef.current;
    if (!s.live) sendFree();
    else send({ type: "deck:role", role: "viewer", max: s.max, locked: autoFollowRef.current });
  }, [role, send, sendFree]);

  // Presenter → broadcast a position, reset the lock, or just heartbeat.
  const postPresenter = useCallback(
    async (opts: { index?: number; reset?: boolean; heartbeat?: boolean }) => {
      try {
        const res = await fetch("/api/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, ...opts }),
        });
        if (res.ok) setSession((await res.json()) as SessionState);
      } catch {
        /* ignore — presenter keeps presenting */
      }
    },
    [slug],
  );

  // Move THIS deck to `index` (a follow) — reason 'api', so it won't re-drive.
  const followTo = useCallback(
    (index: number) => {
      if (index !== deckRef.current.index) send({ type: "deck:goto", index });
    },
    [send],
  );

  // Presenter's own navigation → tell peer presenter windows instantly
  // (BroadcastChannel) and the server (for viewers).
  const drive = useCallback(
    (index: number) => {
      channelRef.current?.post({ type: "state", index });
      void postPresenter({ index });
    },
    [postPresenter],
  );

  // A viewer shared their site link → persist it (tagged with their name) and
  // push the updated wall to the deck.
  const submitPin = useCallback(
    async (url: string) => {
      const who = role === "presenter" ? "Presenter" : nameRef.current || "Viewer";
      try {
        const res = await fetch("/api/pinboard", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, name: who, url }),
        });
        if (res.ok) {
          const { pins } = (await res.json()) as { pins: unknown[] };
          send({ type: "deck:pins", pins });
        }
      } catch {
        /* ignore */
      }
    },
    [slug, role, send],
  );

  // Viewer backchannel reaction (#2): fire-and-forget POST. A 429 (rate_limited)
  // or any error is swallowed — the per-button cooldown is the real guard, and a
  // dropped reaction is harmless.
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
        /* ignore — reactions are best-effort */
      }
    },
    [slug],
  );

  // Cast (or change) this viewer's poll vote (#3). Optimistically marks the choice,
  // then reconciles: a new tap aborts the previous in-flight vote (only the latest
  // matters), and any error — 409 stale/closed, 429 rate-limited, or network —
  // clears the optimistic mark so the next session poll can reconcile.
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
        if (!res.ok) {
          // Stale/closed (409) or rate-limited (429): drop the mark for THIS poll.
          setMyVote((m) => (m && m.pollId === pollId ? null : m));
        }
      } catch (err) {
        // Superseded by a newer tap → that call now owns the mark; leave it.
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
  // privacy-safe token accounting, never a broadcast).
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

  // Upvote a queued question (#5). Optimistically locks the button for this qid,
  // then reflects the server's authoritative count. Idempotent per name, so a
  // double-tap is harmless; a non-OK response (e.g. 404 gone) drops the local lock.
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

  // Post a new question (#5). Resolves to a viewer-facing error string, or null on
  // success (the panel clears its input then). Requires a name — the same gate the
  // poll uses.
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

  // Load stored viewer name.
  useEffect(() => {
    if (role !== "viewer") return;
    try {
      const n = localStorage.getItem(NAME_KEY);
      if (n) {
        setName(n);
        setShowGate(false);
      }
    } catch {
      /* ignore */
    }
  }, [role]);

  // A fresh poll id means a brand-new question — drop any prior "your choice".
  const pollId = poll?.id ?? null;
  useEffect(() => {
    setMyVote(null);
  }, [pollId]);

  // Honor prefers-reduced-motion for the result-bar growth.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduceMotion(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // Abort any in-flight vote / catch-up when the deck unmounts.
  useEffect(() => () => voteCtrlRef.current?.abort(), []);
  useEffect(() => () => catchUpCtrlRef.current?.abort(), []);

  // Q&A queue poll (#5): runs only while the viewer has the panel open, so a closed
  // panel spares Redis. Mirrors the session poll's shape — hidden-tab backoff,
  // catch-up on refocus, and abort on unmount.
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
        /* transient / aborted — next tick */
      }
    }

    function nextDelay(): number {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return QNA_HIDDEN_MS;
      }
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

  // Messages from the deck bridge.
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      const d = e.data as { source?: string; type?: string; reason?: string } & Partial<DeckState>;
      if (!d || d.source !== "deck") return;
      if (d.type === "ready") {
        pushRole();
        if (role === "presenter") channelRef.current?.post({ type: "request" });
        else if (autoFollowRef.current && sessionRef.current.live) followTo(sessionRef.current.index);
      } else if (d.type === "slidechange") {
        const idx = d.index ?? 0;
        setDeck({
          index: idx,
          total: d.total ?? 0,
          label: d.label ?? "",
          nextLabel: d.nextLabel ?? "",
          notes: d.notes ?? "",
        });
        // Only the presenter's OWN navigation drives; followed/initial moves don't.
        const userNav = d.reason !== "api" && d.reason !== "init" && d.reason !== "sync";
        if (role === "presenter" && userNav) drive(idx);
      } else if (d.type === "pinboard:submit") {
        void submitPin(String((d as { url?: string }).url ?? ""));
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [role, pushRole, drive, followTo, submitPin]);

  // Poll the shared session. Presenters follow it (cross-device fallback to the
  // instant BroadcastChannel below); viewers lock/follow only while a presenter
  // is live, and browse freely otherwise.
  useEffect(() => {
    if (role === "viewer" && showGate) return;
    let alive = true;
    let timer: number | undefined;
    let lastLive = false;
    // Aborts any in-flight session/presence fetch when the effect tears down.
    const ctrl = new AbortController();

    // Viewer presence heartbeat (#1): "I'm here, on slide N, following=Y". Runs on
    // the SAME poll tick as the session read (no second timer), so it inherits the
    // adaptive cadence + hidden-tab backoff. Publish-gated — any non-200 just skips
    // this tick. The returned headcount feeds the "N watching" chip.
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
        /* transient / aborted — next tick */
      }
    }

    async function poll() {
      try {
        const res = await fetch(`/api/session?slug=${encodeURIComponent(slug)}`, {
          cache: "no-store",
          signal: ctrl.signal,
        });
        if (!res.ok || !alive) return;
        const s = (await res.json()) as SessionState & {
          poll?: ViewerPoll | null;
          recap?: Recap | null;
        };
        lastLive = s.live;
        setSession(s);
        // Presenter windows sync with each other instantly via BroadcastChannel,
        // never via this poll — polling here would fight local navigation.
        if (role === "presenter") return;
        // The live poll (#3) + room recap ride on this same session read — no
        // extra request.
        setPoll(s.poll ?? null);
        setRecap(s.recap ?? null);
        // Heartbeat presence on every viewer tick (live or free-roam browsing).
        void beat();
        if (!s.live) {
          sendFree();
          return;
        }
        send({ type: "deck:role", role: "viewer", max: s.max, locked: autoFollowRef.current });
        if (autoFollowRef.current) followTo(s.index);
      } catch {
        /* transient — try again next tick */
      }
    }

    // Adaptive cadence: snappy while a presenter is live, lazy when idle, and
    // near-dormant when the tab is backgrounded. This is what keeps a room of
    // open-but-idle tabs from generating a flood of reads.
    function nextDelay(): number {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return HIDDEN_POLL_MS;
      }
      if (role === "presenter") return PRESENTER_POLL_MS;
      return lastLive ? POLL_MS : IDLE_POLL_MS;
    }

    async function loop() {
      if (!alive) return;
      await poll();
      if (!alive) return;
      timer = window.setTimeout(loop, nextDelay());
    }
    void loop();

    // Returning to the foreground should catch up immediately, not wait out a
    // long hidden/idle delay.
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
  }, [role, showGate, slug, send, sendFree, followTo]);

  // Presenter windows on the SAME browser (the projector + the control console)
  // sync instantly via a BroadcastChannel, so they never diverge.
  useEffect(() => {
    if (role !== "presenter") return;
    const ch = createSyncChannel(`deck-live:${slug}`, (msg) => {
      if (msg.type === "request") ch.post({ type: "state", index: deckRef.current.index });
      else if (msg.type === "state" && typeof msg.index === "number") followTo(msg.index);
    });
    channelRef.current = ch;
    ch.post({ type: "request" });
    return () => {
      ch.close();
      channelRef.current = null;
    };
  }, [role, slug, followTo]);

  // Viewer: react to the auto-follow toggle (only meaningful while live).
  useEffect(() => {
    if (role !== "viewer") return;
    const s = sessionRef.current;
    if (!s.live) {
      sendFree();
      return;
    }
    send({ type: "deck:role", role: "viewer", max: s.max, locked: autoFollow });
    if (autoFollow) followTo(s.index);
  }, [autoFollow, role, send, sendFree, followTo]);

  // Presenter: heartbeat so viewers know a session is live even between moves.
  useEffect(() => {
    if (role !== "presenter") return;
    void postPresenter({ heartbeat: true });
    const id = window.setInterval(() => void postPresenter({ heartbeat: true }), 10_000);
    return () => window.clearInterval(id);
  }, [role, postPresenter]);

  // Cover the boot race: the deck may fire its first report before this
  // component's message listener is attached. Keep asking until we have state.
  useEffect(() => {
    if (deck.total > 0) return;
    send({ type: "deck:report" });
    const id = window.setInterval(() => send({ type: "deck:report" }), 350);
    return () => window.clearInterval(id);
  }, [deck.total, send]);

  // Keep the pinboard live while anyone is on the showcase/pinboard slides
  // (index 9 = showcase, 10 = pinboard). Polled only there to spare Redis.
  const onBoard = deck.index >= 9;
  useEffect(() => {
    if (!onBoard) return;
    let alive = true;
    async function pull() {
      try {
        const res = await fetch(`/api/pinboard?slug=${encodeURIComponent(slug)}`, { cache: "no-store" });
        if (!res.ok || !alive) return;
        const { pins } = (await res.json()) as { pins: unknown[] };
        send({ type: "deck:pins", pins });
      } catch {
        /* transient */
      }
    }
    void pull();
    const id = window.setInterval(pull, 3000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [onBoard, slug, send]);

  // Projector cleanliness: on the presenter deck, fade the overlay controls out
  // when idle (activity is forwarded from inside the iframe by the bridge) so it
  // reads as just the slide.
  useEffect(() => {
    if (role !== "presenter") return;
    let timer = 0;
    const show = () => {
      setControlsShown(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setControlsShown(false), 3000);
    };
    const onActivity = (e: MessageEvent) => {
      const m = e.data as { source?: string; type?: string };
      if (m && m.source === "deck" && m.type === "activity") show();
    };
    window.addEventListener("mousemove", show);
    window.addEventListener("keydown", show);
    window.addEventListener("message", onActivity);
    show();
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("mousemove", show);
      window.removeEventListener("keydown", show);
      window.removeEventListener("message", onActivity);
    };
  }, [role]);

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

  const behind = role === "viewer" && session.live && !autoFollow ? session.index - deck.index : 0;
  const unlockedTo = session.max; // 0-based
  const chatName = role === "presenter" ? "Presenter" : name ?? "Viewer";

  const openConsole = () =>
    window.open(`/d/${slug}/presenter`, "presenter-console", "width=1320,height=880");

  // Log out. Presenters have a server session cookie → clear it and return to
  // the login gate. Viewers only have a locally-stored name → drop it and return
  // to the name gate so they can re-join (or hand off to someone else).
  const logout = useCallback(async () => {
    if (role === "presenter") {
      try {
        await fetch("/api/logout", { method: "POST" });
      } catch {
        /* ignore — navigate away regardless */
      }
      window.location.href = "/login";
      return;
    }
    try {
      localStorage.removeItem(NAME_KEY);
    } catch {
      /* ignore */
    }
    setName(null);
    setWatching(0);
    setShowGate(true);
  }, [role]);

  return (
    <div ref={stageRef} style={{ position: "fixed", inset: 0, background: "#ECEAE3", display: "flex" }}>
      <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
        <iframe
          ref={iframeRef}
          src={embedUrl}
          title={title}
          onLoad={() => {
            // In case the bridge posted "ready" before this handler attached.
            window.setTimeout(pushRole, 200);
          }}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0, display: "block" }}
          allow="fullscreen"
        />

        {/* top-right control cluster (auto-hides on the presenter/projector) */}
        <div
          style={{
            position: "absolute",
            top: 14,
            right: 16,
            zIndex: 40,
            display: "flex",
            alignItems: "center",
            gap: 8,
            opacity: role === "presenter" && !controlsShown ? 0 : 1,
            transition: "opacity 0.3s ease",
            pointerEvents: role === "presenter" && !controlsShown ? "none" : "auto",
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
              <span style={glassChip()}>Viewers unlocked → slide {unlockedTo + 1}</span>
              <button onClick={() => void postPresenter({ reset: true })} style={pill("#B5331F", "#FFF")} title="Set the current slide as the viewers' ceiling">
                Reset lock
              </button>
              <button onClick={openConsole} style={pill("#2C2A31", "#F4F2EC")} title="Open the presenter view (next slide, notes, timer)">
                Presenter view ↗
              </button>
              <ChatButton open={chatOpen} onClick={() => setChatOpen((o) => !o)} />
              <Link href="/dashboard" style={{ ...glassChip(), textDecoration: "none" }} title="Back to dashboard">
                Dashboard
              </Link>
            </>
          )}
          <LogoutButton role={role} onClick={logout} />
        </div>

        {/* Live poll overlay (#3) — a viewer card over the slide (bottom-left, so it
            never covers the top-right controls). Vanishes when the poll closes. */}
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

        {/* Bottom-center card stack — the room recap (presenter-broadcast) and
            this viewer's personal catch-up card share one column so they never
            overlap; both clear the poll card (bottom-left) and Q&A panel (right). */}
        {role === "viewer" && ((recap && recap.id !== dismissedRecapId) || catchUp) && (
          <div style={centerCardStack}>
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

        {/* Q&A queue (#5) — a viewer panel anchored to the right, below the top
            controls; the poll card sits bottom-left so the two never collide. */}
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

// ---- pieces -----------------------------------------------------------------

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

function LogoutButton({ role, onClick }: { role: Role; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label="Log out"
      title={role === "presenter" ? "End your presenter session" : "Leave and clear your name"}
      style={{ ...glassChip(), cursor: "pointer" }}
    >
      Log out
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

// Toggle for the viewer's Q&A queue (#5). Shows the last-known question count once
// the panel has fetched it. Distinct from the tutor "Ask" chat above.
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

// A compact reaction row (#2). Each tap fires one signal, pulses the button, and
// starts a ~3s local cooldown so a viewer can't machine-gun it (the server also
// rate-limits). "I'm lost" is styled distinctly to stand out.
function ReactionBar({ onSend }: { onSend: (kind: SignalKind) => void }) {
  const [cooling, setCooling] = useState<Record<string, boolean>>({});
  const [pulse, setPulse] = useState<SignalKind | null>(null);
  const timers = useRef<number[]>([]);
  useEffect(
    () => () => {
      timers.current.forEach((t) => window.clearTimeout(t));
    },
    [],
  );

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
        <button
          key={r.kind}
          onClick={() => tap(r.kind)}
          disabled={!!cooling[r.kind]}
          title={r.label}
          aria-label={r.label}
          style={reactionBtn(pulse === r.kind, !!cooling[r.kind])}
        >
          {r.emoji}
        </button>
      ))}
      <button
        onClick={() => tap("lost")}
        disabled={!!cooling.lost}
        title="I'm lost — let the presenter know"
        aria-label="I'm lost"
        style={lostBtn(pulse === "lost", !!cooling.lost)}
      >
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
        <div style={{ fontSize: 20, fontWeight: 500, color: "#262229", letterSpacing: "-0.01em" }}>Welcome to the workshop</div>
        <div style={{ fontSize: 13.5, fontWeight: 300, color: "#6E6A62", lineHeight: 1.5 }}>
          What should we call you? Your name appears on anything you share to the pinboard.
        </div>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Your name"
          autoFocus
          maxLength={40}
          style={{
            height: 46,
            padding: "0 14px",
            borderRadius: 12,
            border: "1px solid rgba(60,55,45,0.18)",
            background: "rgba(255,255,255,0.8)",
            fontFamily: "inherit",
            fontSize: 15,
            color: "#2C2A31",
            outline: "none",
          }}
        />
        <button
          type="submit"
          disabled={!value.trim()}
          style={{
            height: 46,
            borderRadius: 12,
            border: "none",
            background: value.trim() ? "#2C2A31" : "#B7B2A8",
            color: "#F4F2EC",
            fontFamily: "inherit",
            fontSize: 15,
            fontWeight: 500,
            cursor: value.trim() ? "pointer" : "default",
          }}
        >
          Join the room
        </button>
      </form>
    </div>
  );
}

// The viewer's live-poll card (#3). Pre-reveal: tap an option to vote (the mark is
// optimistic; re-tap to change until reveal). Revealed: horizontal bars sized by
// each option's share, the correct answer flagged green, and this viewer's pick
// tagged. Styled to match the glass control chips.
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

  return (
    <div style={pollCardWrap} role="group" aria-label="Live poll">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <span style={pollBadge}>{revealed ? "Results" : "Live poll"}</span>
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
            const correct = poll.correctIndex === i;
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
                    {correct && <span style={pollTag("#3F7A12")}>✓ correct</span>}
                    {mine && <span style={pollTag("#6E6A62")}>your pick</span>}
                  </span>
                  <span style={{ fontWeight: 600, color: "#3A372F", flex: "0 0 auto" }}>{count}</span>
                </div>
              </div>
            );
          })}
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
    background: correct
      ? "rgba(120,176,54,0.34)"
      : mine
        ? "rgba(44,42,49,0.16)"
        : "rgba(120,116,108,0.16)",
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

// The viewer's recap card (comprehension checkpoint): the presenter pushed a short
// AI recap of the slide because part of the room felt lost. Purely informational —
// one dismiss button, no inputs. Dismissal is local to this viewer.
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

// The viewer's Q&A queue panel (#5). Read the room's questions (already sorted
// top-voted first), upvote with one tap (locks locally; the server is idempotent),
// and post your own. Anchored to the right so it clears the bottom-left poll card.
// Owns only its input state — the queue + vote marks live in the parent so they
// persist across open/close.
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

const qnaErrorText: React.CSSProperties = {
  fontSize: 12,
  color: "#B5331F",
  fontWeight: 500,
};

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
