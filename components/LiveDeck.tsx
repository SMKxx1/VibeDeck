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
import {
  HIDDEN_POLL_MS,
  IDLE_POLL_MS,
  NAME_KEY,
  POLL_MS,
  PRESENTER_POLL_MS,
  QNA_HIDDEN_MS,
  QNA_POLL_MS,
  type Activity,
  type CatchUp,
  type QnaQuestion,
  type Recap,
  type SessionState,
  type SignalKind,
  type ViewerPoll,
  type ViewerRole,
} from "./live/types";
import { ChatButton, FollowToggle, FullscreenButton, QnaButton, glassChip, pill } from "./live/chrome";
import { ReactionBar } from "./live/ReactionBar";
import { PollCard } from "./live/PollCard";
import { QnaPanel } from "./live/QnaPanel";
import { ActivityCard } from "./live/ActivityCard";
import { RecapCard } from "./live/RecapCard";
import { CatchUpCard, centerCardStack } from "./live/CatchUpCard";

interface DeckState {
  index: number;
  total: number;
  label: string;
  nextLabel: string;
  notes: string;
}

export function LiveDeck({
  slug,
  embedUrl,
  role,
  title,
}: {
  slug: string;
  embedUrl: string;
  role: ViewerRole;
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
  // Turn & Talk activity card: presenter-broadcast, riding the same session poll.
  // Hide is local (per activity id); the countdown runs client-side from endsAt.
  const [activity, setActivity] = useState<Activity | null>(null);
  const [hiddenActivityId, setHiddenActivityId] = useState<string | null>(null);
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

  // Presenter → broadcast a position, reset the lock, heartbeat, or take the clicker.
  const postPresenter = useCallback(
    async (opts: { index?: number; reset?: boolean; heartbeat?: boolean; takeClicker?: boolean }) => {
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
  // (BroadcastChannel) and the server (for viewers). Co-host mode: a moderator
  // (clicker held by the co-host) never writes the shared index — the server
  // would ignore it anyway; skipping spares the round-trip.
  const drive = useCallback(
    (index: number) => {
      channelRef.current?.post({ type: "state", index });
      if (sessionRef.current.isDriver !== false) void postPresenter({ index });
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
      // SECURITY GUARD — object-identity of OUR frame + the deck marker, so a
      // hostile page that holds a window ref to the app can't forge deck messages.
      if (!(e.source === iframeRef.current?.contentWindow && d?.source === "deck")) return;
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
          activity?: Activity | null;
        };
        lastLive = s.live;
        setSession(s);
        // Presenter windows sync with each other instantly via BroadcastChannel,
        // never via this poll — polling here would fight local navigation.
        // Co-host mode is the exception: a moderator follows the driver (the goto
        // reports back as reason 'api', so it never re-drives).
        if (role === "presenter") {
          if (s.isDriver === false) followTo(s.index);
          return;
        }
        // The live poll (#3) + room recap + Turn & Talk activity ride on this
        // same session read — no extra request.
        setPoll(s.poll ?? null);
        setRecap(s.recap ?? null);
        setActivity(s.activity ?? null);
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
      // Same receive guard as the main bridge listener — only OUR iframe's window.
      if (e.source === iframeRef.current?.contentWindow && m && m.source === "deck" && m.type === "activity") show();
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
              {session.isDriver !== false ? (
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

        {/* Bottom-center card stack — the Turn & Talk activity card, the room
            recap (presenter-broadcast) and this viewer's personal catch-up card
            share one column so they never overlap; all clear the poll card
            (bottom-left) and Q&A panel (right). */}
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

function LogoutButton({ role, onClick }: { role: ViewerRole; onClick: () => void }) {
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
    case "password_required":
      return "Open the AI chat and enter the class code first.";
    case "timeout":
      return "That took too long — try again.";
    default:
      return "Couldn't catch you up — try again.";
  }
}
