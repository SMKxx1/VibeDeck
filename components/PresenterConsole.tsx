"use client";

// The presenter view — a dedicated window (opened from the deck's "Presenter
// view" button) that shows the CURRENT slide, a live preview of the NEXT slide,
// the speaker notes, and a timer, with prev/next + reset-lock. It DRIVES the
// live session (so viewers + the projector follow) and heartbeats to keep the
// session "live". Meant for the presenter's screen while the projector shows the
// clean deck (open "/" there).

import { useCallback, useEffect, useRef, useState } from "react";
import { createSyncChannel, type SyncChannel } from "@/lib/sync";
import { PulseHeatStrip, InsightPanel, type PulseSlideDto } from "@/components/InsightPulse";

const POLL_MS = Number(process.env.NEXT_PUBLIC_SESSION_POLL_MS) || 2000;
// Roster + backchannel polling for the live-room panels (#1/#2). Every ~4s, and
// far slower when the tab is hidden so a backgrounded console doesn't hammer Redis.
const PRESENCE_POLL_MS = 4_000;
const PRESENCE_HIDDEN_MS = 30_000;

// Comprehension checkpoint: when this many DISTINCT viewers hit "I'm lost" inside
// the meter's 15s window (see /api/signal GET), surface the one-tap fixes. The
// meter decays fast, so it inherently reflects the slide being shown right now.
const LOST_THRESHOLD = 3;

type SignalKind = "up" | "party" | "slow" | "hand" | "lost";
// Only these float; slow/lost drive the persistent "help" meter instead.
const ANIMATE_KINDS = new Set<SignalKind>(["up", "party", "hand"]);
const REACTION_EMOJI: Record<string, string> = { up: "👍", party: "🎉", hand: "🙋" };
const FLOAT_KEYFRAMES =
  "@keyframes vibedeck-rise{0%{transform:translateY(0) scale(0.7);opacity:0}15%{opacity:1}100%{transform:translateY(-150px) scale(1.15);opacity:0}}";

interface Signal {
  name: string;
  kind: SignalKind;
  at: number;
}
interface Viewer {
  name: string;
  index: number;
  follow: boolean;
}

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
  live: boolean;
  // Co-host mode: false when ANOTHER presenter holds the clicker (slide control).
  // Absent/true — including an unclaimed session — means this console drives.
  isDriver?: boolean;
}

// A branch-point path (lib/types.ts SlideBranch) — 0-based inclusive range.
interface SlideBranch {
  label: string;
  from: number;
  to: number;
}

// The full poll record (#3) — the presenter sees the correct answer + the live
// tally, unlike the viewer-safe projection delivered on /api/session.
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

// The active room recap (comprehension checkpoint) — set via /api/recap and
// delivered on the same /api/session poll viewers already run.
interface Recap {
  id: string;
  text: string;
  slideIndex: number;
  at: number;
}

// The active Turn & Talk activity — set via /api/activity and delivered on the
// same /api/session poll. Everyone (this console included) counts down
// CLIENT-SIDE from `endsAt`; "Regroup" clears it everywhere at once.
type ActivityFollowUp = "poll" | "pinboard";
interface Activity {
  id: string;
  prompt: string;
  endsAt: number; // epoch ms
  followUp: ActivityFollowUp | null;
  at: number;
}

// A question in the upvotable Q&A queue (#5). The presenter's GET is cookie-authed,
// so it also includes dismissed entries (viewers never see those).
interface QnaQuestion {
  id: string;
  name: string;
  text: string;
  votes: number;
  answered: boolean;
  dismissed: boolean;
  at: number;
}

export function PresenterConsole({
  slug,
  embedUrl,
  title,
}: {
  slug: string;
  embedUrl: string;
  title: string;
}) {
  const mainRef = useRef<HTMLIFrameElement>(null);
  const previewRef = useRef<HTMLIFrameElement>(null);

  const [deck, setDeck] = useState<DeckState>({ index: 0, total: 0, label: "", nextLabel: "", notes: "" });
  const [session, setSession] = useState<SessionState>({ index: 0, max: 0, live: false });
  // Presenter-edited speaker notes from the DB (index → notes). Fetched once;
  // preferred over the embed deck's own bridge notes when non-empty. If the DB
  // is unavailable the fetch fails silently and we keep the bridge notes.
  const [dbNotes, setDbNotes] = useState<Record<number, string>>({});

  // Live-room state (#1 roster / #2 reactions + help meter).
  const [roster, setRoster] = useState<{ count: number; viewers: Viewer[] }>({ count: 0, viewers: [] });
  const [help, setHelp] = useState<{ lost: number; slow: number }>({ lost: 0, slow: 0 });
  const [reactionCount, setReactionCount] = useState(0); // animate-kind signals in window → reduced-motion badge
  const [floats, setFloats] = useState<{ id: number; emoji: string; left: number }[]>([]);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  // Live poll (#3/#4). `livePoll` is the current open/revealed poll (null = none,
  // so the panel shows the compose form); `liveTally`/`liveTotal` are refreshed on
  // the same ~4s console tick as presence/reactions.
  const [pollPanelOpen, setPollPanelOpen] = useState(false);
  const [livePoll, setLivePoll] = useState<Poll | null>(null);
  const [liveTally, setLiveTally] = useState<number[]>([]);
  const [liveTotal, setLiveTotal] = useState(0);

  // Branch points: index → authored paths for this deck (fetched once; {} when
  // the DB is unavailable or the deck has none). Drives "Open branch vote".
  const [deckBranches, setDeckBranches] = useState<Record<number, SlideBranch[]>>({});

  // Q&A queue (#5): the full cookie-authed queue (includes dismissed), refreshed on
  // the same ~4s console tick as presence/signals/poll.
  const [qnaPanelOpen, setQnaPanelOpen] = useState(false);
  const [questions, setQuestions] = useState<QnaQuestion[]>([]);

  // Comprehension checkpoint: the active room recap (null = none) + send state,
  // and a pending "Launch check" auto-draft the poll panel consumes on open.
  const [recap, setRecap] = useState<Recap | null>(null);
  const [recapSending, setRecapSending] = useState(false);
  const [recapError, setRecapError] = useState<string | null>(null);
  const [pendingAutoDraft, setPendingAutoDraft] = useState(false);

  // Turn & Talk: the active activity (null = none, so the panel shows the
  // compose form). Delivered on the same session tick as the recap.
  const [activityPanelOpen, setActivityPanelOpen] = useState(false);
  const [activity, setActivity] = useState<Activity | null>(null);

  // Insight Engine: the live confusion-pulse aggregates (heat strip) — refreshed
  // on the same ~4s console tick as presence/signals — and the debrief panel.
  const [pulseSlides, setPulseSlides] = useState<PulseSlideDto[]>([]);
  const [insightPanelOpen, setInsightPanelOpen] = useState(false);

  const sessionRef = useRef(session);
  sessionRef.current = session;
  const deckRef = useRef(deck);
  deckRef.current = deck;
  const channelRef = useRef<SyncChannel | null>(null);
  const previewIdxRef = useRef(-1);

  // Latest poll (for the tick's race guards) + the id we just closed (so an
  // in-flight pre-close read can't resurrect it) + the in-flight control request.
  const livePollRef = useRef(livePoll);
  livePollRef.current = livePoll;
  const closedPollIdRef = useRef<string | null>(null);
  const pollCtrlRef = useRef<AbortController | null>(null);

  // Latest recap + the id we just cleared, so an in-flight pre-clear session read
  // can't resurrect it for one tick (same guard as closedPollIdRef above).
  const recapRef = useRef(recap);
  recapRef.current = recap;
  const clearedRecapIdRef = useRef<string | null>(null);

  // Latest activity + the id we just regrouped (same one-tick resurrection guard).
  const activityRef = useRef(activity);
  activityRef.current = activity;
  const clearedActivityIdRef = useRef<string | null>(null);

  // "New reaction" detection: the max signal timestamp already handled, so a
  // signal seen on an earlier poll is never re-animated.
  const lastAtRef = useRef(0);
  const seededRef = useRef(false);
  const floatIdRef = useRef(0);
  const floatTimersRef = useRef<number[]>([]);
  const reduceMotionRef = useRef(reduceMotion);
  reduceMotionRef.current = reduceMotion;

  const sendMain = useCallback((msg: Record<string, unknown>) => {
    mainRef.current?.contentWindow?.postMessage(msg, "*");
  }, []);
  const sendPreview = useCallback((msg: Record<string, unknown>) => {
    previewRef.current?.contentWindow?.postMessage(msg, "*");
  }, []);

  const post = useCallback(
    async (opts: { index?: number; reset?: boolean; heartbeat?: boolean; takeClicker?: boolean }) => {
      try {
        const res = await fetch("/api/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, ...opts }),
        });
        if (res.ok) setSession((await res.json()) as SessionState);
      } catch {
        /* ignore */
      }
    },
    [slug],
  );

  const setPreviewTo = useCallback(
    (nextIdx: number, total: number) => {
      const clamped = total ? Math.min(Math.max(0, nextIdx), total - 1) : Math.max(0, nextIdx);
      if (clamped === previewIdxRef.current) return;
      previewIdxRef.current = clamped;
      sendPreview({ type: "deck:goto", index: clamped });
    },
    [sendPreview],
  );

  // Move the main deck to `index` if not already there (a follow — reason 'api').
  const followMain = useCallback(
    (index: number) => {
      if (index !== deckRef.current.index) sendMain({ type: "deck:goto", index });
    },
    [sendMain],
  );

  // This console navigated → tell peer presenter windows instantly + the server.
  // Co-host mode: a moderator (clicker held by the co-host) never writes the shared
  // index — the server would ignore it anyway; skipping spares the round-trip.
  const drive = useCallback(
    (index: number) => {
      channelRef.current?.post({ type: "state", index });
      if (sessionRef.current.isDriver !== false) void post({ index });
    },
    [post],
  );

  // Poll control (#3). Each action aborts any prior in-flight control request and
  // optimistically updates the panel from the response; the tick reconciles.
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
    // Remember the id so an in-flight pre-close read can't resurrect it, then
    // optimistically clear back to the compose form.
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
  // session jump; on success we move THIS console's own deck too — the goto
  // reports back as reason 'api', so it can't re-drive the session.
  const routeBranchAction = useCallback(
    async (optionIndex: number): Promise<boolean> => {
      try {
        const res = await pollAction({ action: "route", optionIndex });
        if (!res.ok) return false;
        const data = (await res.json()) as { poll?: Poll; index?: number; routed?: boolean };
        if (data.poll) setLivePoll(data.poll);
        if (data.routed && typeof data.index === "number") {
          sendMain({ type: "deck:goto", index: data.index });
        }
        return data.routed === true;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return false;
        return false;
      }
    },
    [pollAction, sendMain],
  );

  // Load this deck's branch points once (presenter-gated read; silently {} when
  // there are none or the DB is down — the affordance simply doesn't appear).
  useEffect(() => {
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
  }, [slug]);

  // Comprehension checkpoint actions. "Send recap" resolves + broadcasts an AI
  // recap of the CURRENT slide (the server is cache-first, so a repeat is free);
  // "Clear recap" removes the overlay for every viewer.
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

  // Turn & Talk actions. "Start" broadcasts the prompt + a synchronized countdown
  // (the server computes endsAt at write time, so the whole room counts down to
  // the same instant); "Regroup" ends it everywhere at once and, for a "poll"
  // follow-up, chains into the SAME reviewed ✨ draft flow as "Launch check"
  // (never auto-launches — the presenter reviews).
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
      setPollPanelOpen(true);
      setPendingAutoDraft(true);
    }
  }, [slug]);

  // Q&A control (#5): answer / dismiss / undismiss. Each returns the fresh sorted
  // queue, which we adopt directly; the ~4s tick reconciles thereafter.
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

  // Abort any in-flight poll control request on unmount.
  useEffect(() => () => pollCtrlRef.current?.abort(), []);

  // Messages from either iframe (main = driver, preview = next-slide).
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      const d = e.data as { source?: string; type?: string; reason?: string } & Partial<DeckState>;
      if (!d || d.source !== "deck") return;
      const fromMain = e.source === mainRef.current?.contentWindow;
      const fromPreview = e.source === previewRef.current?.contentWindow;

      if (fromMain) {
        if (d.type === "ready") {
          sendMain({ type: "deck:role", role: "presenter" });
          channelRef.current?.post({ type: "request" });
          followMain(sessionRef.current.index);
        } else if (d.type === "slidechange") {
          const idx = d.index ?? 0;
          const total = d.total ?? 0;
          setDeck({ index: idx, total, label: d.label ?? "", nextLabel: d.nextLabel ?? "", notes: d.notes ?? "" });
          setPreviewTo(idx + 1, total);
          // Only this console's own navigation drives; followed moves don't.
          const userNav = d.reason !== "api" && d.reason !== "init" && d.reason !== "sync";
          if (userNav) drive(idx);
        }
      } else if (fromPreview) {
        if (d.type === "ready") {
          // Freeze the preview: it never drives, and its own nav is disabled.
          sendPreview({ type: "deck:role", role: "viewer", locked: true, max: 1e9 });
          const total = d.total ?? 0;
          previewIdxRef.current = -1;
          setPreviewTo((sessionRef.current.index ?? 0) + 1, total);
        }
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [sendMain, sendPreview, setPreviewTo, drive, followMain]);

  // Instant sync with the projector window (same browser) via BroadcastChannel.
  useEffect(() => {
    const ch = createSyncChannel(`deck-live:${slug}`, (msg) => {
      if (msg.type === "request") ch.post({ type: "state", index: deckRef.current.index });
      else if (msg.type === "state" && typeof msg.index === "number") followMain(msg.index);
    });
    channelRef.current = ch;
    ch.post({ type: "request" });
    return () => {
      ch.close();
      channelRef.current = null;
    };
  }, [slug, followMain]);

  // Poll the session for display only (viewers-unlocked count / live). The
  // projector is kept in sync via BroadcastChannel, not this poll.
  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const res = await fetch(`/api/session?slug=${encodeURIComponent(slug)}`, { cache: "no-store" });
        if (!res.ok || !alive) return;
        const s = (await res.json()) as SessionState & {
          recap?: Recap | null;
          activity?: Activity | null;
        };
        setSession(s);
        // Co-host mode: a moderator's console follows the driver (the goto reports
        // back as reason 'api', so it can never re-drive the session).
        if (s.isDriver === false) followMain(s.index);
        // The active room recap rides the same session read. Skip the one we just
        // cleared — its id can linger for one in-flight tick.
        const r = s.recap ?? null;
        if (!r || r.id !== clearedRecapIdRef.current) setRecap(r);
        // The Turn & Talk activity rides here too (same just-cleared guard), so a
        // co-host's console shows the running countdown + Regroup.
        const a = s.activity ?? null;
        if (!a || a.id !== clearedActivityIdRef.current) setActivity(a);
      } catch {
        /* transient */
      }
    }
    void tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [slug, followMain]);

  useEffect(() => {
    void post({ heartbeat: true });
    const id = window.setInterval(() => void post({ heartbeat: true }), 10_000);
    return () => window.clearInterval(id);
  }, [post]);

  // Load presenter-edited notes from the DB once (presenter is authenticated on
  // this page). Failure is silent — we simply keep the embed deck's own notes.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/admin/slides?slug=${encodeURIComponent(slug)}`, {
          cache: "no-store",
        });
        if (!res.ok || !alive) return;
        const data = (await res.json()) as { slides?: { index: number; speakerNotes: string }[] };
        const map: Record<number, string> = {};
        for (const s of data.slides ?? []) map[s.index] = s.speakerNotes ?? "";
        if (alive) setDbNotes(map);
      } catch {
        /* DB unavailable — keep bridge notes */
      }
    })();
    return () => {
      alive = false;
    };
  }, [slug]);

  // Boot-race: keep asking the main deck for its state until we have it.
  useEffect(() => {
    if (deck.total > 0) return;
    sendMain({ type: "deck:report" });
    const id = window.setInterval(() => sendMain({ type: "deck:report" }), 350);
    return () => window.clearInterval(id);
  }, [deck.total, sendMain]);

  // Honor prefers-reduced-motion: swap floating emoji for a small count badge.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduceMotion(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // Clear any pending float timers on unmount.
  useEffect(
    () => () => {
      floatTimersRef.current.forEach((t) => window.clearTimeout(t));
      floatTimersRef.current = [];
    },
    [],
  );

  // Poll the roster (#1) and the backchannel (#2) together on one ~4s timer.
  // Presenter-gated GETs (this route carries the presenter cookie). Backs off when
  // the tab is hidden and catches up on return; aborts in-flight fetches on unmount.
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const ctrl = new AbortController();
    const enc = encodeURIComponent(slug);

    function spawnFloat(emoji: string) {
      if (!alive) return;
      const id = ++floatIdRef.current;
      const left = 10 + Math.random() * 66; // % across the current slide
      setFloats((f) => [...f, { id, emoji, left }]);
      const t = window.setTimeout(() => {
        if (!alive) return;
        setFloats((f) => f.filter((x) => x.id !== id));
      }, 2100);
      floatTimersRef.current.push(t);
    }

    // Animate only signals newer than the max `at` already handled.
    function onSignals(list: Signal[]) {
      const maxAt = list.length ? list[0].at : lastAtRef.current; // signals are newest-first
      if (!seededRef.current) {
        // First poll: adopt the current max without animating the backlog.
        seededRef.current = true;
        lastAtRef.current = list.length ? maxAt : 0;
        return;
      }
      const fresh = list.filter((s) => s.at > lastAtRef.current && ANIMATE_KINDS.has(s.kind));
      if (list.length) lastAtRef.current = Math.max(lastAtRef.current, maxAt);
      if (!fresh.length || reduceMotionRef.current) return;
      // Oldest-first so a burst staggers as it rises.
      fresh
        .slice()
        .reverse()
        .forEach((s, i) => {
          const t = window.setTimeout(() => spawnFloat(REACTION_EMOJI[s.kind] ?? "✨"), i * 140);
          floatTimersRef.current.push(t);
        });
    }

    async function tick() {
      try {
        // Fold the live-poll tally (#3), Q&A queue (#5) and the confusion pulse
        // (Insight Engine heat strip) into the same tick as presence + reactions
        // — one round-trip, one abort signal.
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
          // Skip two stale reads: a poll we just closed (its id lingers one tick),
          // and a pre-reveal snapshot that would un-reveal a just-revealed poll.
          const stale =
            !!incoming &&
            ((incoming.id === closedPollIdRef.current) ||
              (!!cur && cur.id === incoming.id && cur.revealed && !incoming.revealed));
          if (!stale) {
            setLivePoll(incoming);
            setLiveTally(incoming ? (data.tally ?? []) : []);
            setLiveTotal(incoming ? (data.total ?? 0) : 0);
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
        /* transient / aborted — try again next tick */
      }
    }

    function nextDelay(): number {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return PRESENCE_HIDDEN_MS;
      }
      return PRESENCE_POLL_MS;
    }

    async function loop() {
      if (!alive) return;
      await tick();
      if (!alive) return;
      timer = window.setTimeout(loop, nextDelay());
    }
    void loop();

    // Returning to the foreground catches up immediately.
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
  }, [slug]);

  const atStart = deck.index <= 0;
  const atEnd = deck.total > 0 && deck.index >= deck.total - 1;

  // Co-host mode: does THIS presenter hold the clicker? Absent (solo/legacy or an
  // unclaimed session) counts as yes, so a lone presenter is never gated.
  const isDriver = session.isDriver !== false;
  const prevOff = atStart || !isDriver;
  const nextOff = atEnd || !isDriver;

  // Prefer the presenter-edited DB note for the current slide when non-empty;
  // otherwise fall back to the note the embed deck sent over the bridge.
  const dbNote = dbNotes[deck.index];
  const noteText = dbNote && dbNote.trim() ? dbNote : deck.notes;

  // Roster breakdown against the presenter's CURRENT slide (#1):
  //   following = following the presenter · behind = free & on an earlier slide ·
  //   exploring = everyone else (free & at/ahead of the presenter).
  const presenterIdx = deck.index;
  let following = 0;
  let behind = 0;
  let exploring = 0;
  for (const v of roster.viewers) {
    if (v.follow) following += 1;
    else if (v.index < presenterIdx) behind += 1;
    else exploring += 1;
  }

  // The header badge counts the live (non-dismissed) queue.
  const qnaActiveCount = questions.reduce((n, q) => (q.dismissed ? n : n + 1), 0);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#22201F", color: "#F4F2EC", fontFamily: '"Outfit", system-ui, sans-serif', display: "flex", flexDirection: "column" }}>
      <style>{FLOAT_KEYFRAMES}</style>
      {/* header */}
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "12px 20px", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, minWidth: 0 }}>
          <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.16em", textTransform: "uppercase", color: "#BFE048" }}>Presenter</span>
          <span style={{ fontSize: 15, fontWeight: 500 }}>{title}</span>
          <span style={{ fontSize: 13, color: "#9A958A" }}>
            slide {deck.index + 1}{deck.total ? ` / ${deck.total}` : ""} · viewers unlocked → {session.max + 1}
          </span>
          <PresenceStat
            watching={roster.count}
            following={following}
            exploring={exploring}
            behind={behind}
            viewers={roster.viewers}
            open={rosterOpen}
            onOpenChange={setRosterOpen}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
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
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            onClick={() => setPollPanelOpen((o) => !o)}
            title="Live poll & AI knowledge-check"
            aria-pressed={pollPanelOpen}
            style={{
              ...btn(pollPanelOpen ? "#BFE048" : "rgba(255,255,255,0.1)", pollPanelOpen ? "#1B1B20" : "#F4F2EC"),
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
            }}
          >
            📊 Poll{livePoll ? (livePoll.revealed ? " · revealed" : " · live") : ""}
          </button>
          <button
            onClick={() => setQnaPanelOpen((o) => !o)}
            title="Audience questions & AI confusion digest"
            aria-pressed={qnaPanelOpen}
            style={{
              ...btn(qnaPanelOpen ? "#BFE048" : "rgba(255,255,255,0.1)", qnaPanelOpen ? "#1B1B20" : "#F4F2EC"),
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
            }}
          >
            ❓ Questions{qnaActiveCount > 0 ? ` · ${qnaActiveCount}` : ""}
          </button>
          <button
            onClick={() => setActivityPanelOpen((o) => !o)}
            title="Turn & Talk — broadcast a discussion prompt + countdown to every viewer"
            aria-pressed={activityPanelOpen}
            style={{
              ...btn(activityPanelOpen ? "#BFE048" : "rgba(255,255,255,0.1)", activityPanelOpen ? "#1B1B20" : "#F4F2EC"),
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
            }}
          >
            ⏱ Turn &amp; Talk{activity ? " · live" : ""}
          </button>
          <button
            onClick={() => setInsightPanelOpen((o) => !o)}
            title="Room insights — where viewers are struggling + the AI session debrief"
            aria-pressed={insightPanelOpen}
            style={{
              ...btn(insightPanelOpen ? "#BFE048" : "rgba(255,255,255,0.1)", insightPanelOpen ? "#1B1B20" : "#F4F2EC"),
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
            }}
          >
            🔥 Insights
          </button>
          <ConsoleTimer />
          {isDriver ? (
            <span
              title="You control the room's slide position"
              style={{ fontSize: 12, fontWeight: 600, color: "#BFE048", whiteSpace: "nowrap", opacity: 0.85 }}
            >
              🖱 You have the clicker
            </span>
          ) : (
            <button
              onClick={() => void post({ takeClicker: true })}
              title="Take slide control from your co-host"
              style={btn("#BFE048", "#1B1B20")}
            >
              🖱 Take the clicker
            </button>
          )}
          <button onClick={() => void post({ reset: true })} title="Set the current slide as the viewers' ceiling" style={btn("#B5331F", "#fff")}>
            Reset lock
          </button>
        </div>
      </header>

      {/* body */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 16, padding: 16 }}>
        {/* current + nav */}
        <div style={{ flex: 1.7, minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
          <Label>Current</Label>
          <div style={{ position: "relative", flex: 1, minHeight: 0, borderRadius: 12, overflow: "hidden", background: "#000", border: "1px solid rgba(255,255,255,0.12)" }}>
            <iframe
              ref={mainRef}
              src={embedUrl}
              title={title}
              onLoad={() => window.setTimeout(() => sendMain({ type: "deck:report" }), 200)}
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0 }}
              allow="fullscreen"
            />
            {/* Floating viewer reactions (#2) — rise + fade over the slide. */}
            <div style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden", zIndex: 5 }} aria-hidden>
              {!reduceMotion &&
                floats.map((f) => (
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
          </div>
          {/* Insight Engine heat strip — one cell per slide, intensity = struggle
              signals (tooltip has the breakdown). Only rendered once there's a
              slide count AND at least one signal, so it never adds dead chrome. */}
          {deck.total > 0 && pulseSlides.length > 0 && (
            <PulseHeatStrip slides={pulseSlides} total={deck.total} currentIndex={deck.index} variant="dark" />
          )}
          <div style={{ display: "flex", gap: 12 }}>
            <button
              onClick={() => sendMain({ type: "deck:advance", dir: -1 })}
              disabled={prevOff}
              title={isDriver ? undefined : "Your co-host has the clicker — take it to drive"}
              style={navBtn(prevOff)}
            >
              ‹ Prev
            </button>
            <button
              onClick={() => sendMain({ type: "deck:advance", dir: 1 })}
              disabled={nextOff}
              title={isDriver ? undefined : "Your co-host has the clicker — take it to drive"}
              style={{ ...navBtn(nextOff), flex: 1, background: nextOff ? "#3A3838" : "#BFE048", color: nextOff ? "#7A7770" : "#1B1B20" }}
            >
              Next ›
            </button>
          </div>
        </div>

        {/* next preview + notes */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
          <Label>Next{deck.nextLabel ? ` · ${deck.nextLabel}` : ""}</Label>
          <div style={{ position: "relative", aspectRatio: "16 / 9", borderRadius: 12, overflow: "hidden", background: "#000", border: "1px solid rgba(255,255,255,0.12)" }}>
            {atEnd ? (
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#9A958A", fontSize: 14 }}>
                End of deck
              </div>
            ) : (
              <iframe
                ref={previewRef}
                src={embedUrl}
                title="Next slide preview"
                tabIndex={-1}
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0, pointerEvents: "none" }}
              />
            )}
          </div>
          <Label>Notes</Label>
          <div style={{ flex: 1, minHeight: 0, overflow: "auto", borderRadius: 12, padding: "14px 16px", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", fontSize: 15, lineHeight: 1.6, color: "#E7E4DC", whiteSpace: "pre-wrap" }}>
            {noteText || <span style={{ color: "#7A7770" }}>No notes for this slide.</span>}
          </div>
        </div>

        {/* live poll panel (#3/#4) — compose · AI draft · live results */}
        {pollPanelOpen && (
          <PollPanel
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

        {/* Q&A queue panel (#5) — digest · queue · answer/dismiss · one-tap AI answer */}
        {qnaPanelOpen && (
          <QnaPanel
            questions={questions}
            slug={slug}
            index={deck.index}
            onAction={qnaAction}
            onDismiss={() => setQnaPanelOpen(false)}
          />
        )}

        {/* Turn & Talk panel — compose (prompt · duration · follow-up) or the
            running countdown + Regroup. */}
        {activityPanelOpen && (
          <ActivityPanel
            activity={activity}
            onStart={startActivity}
            onRegroup={() => void regroupActivity()}
            onDismiss={() => setActivityPanelOpen(false)}
          />
        )}

        {/* Insight panel — live struggle breakdown + the AI session debrief. */}
        {insightPanelOpen && (
          <div style={pollPanelWrap}>
            <InsightPanel
              slug={slug}
              slides={pulseSlides}
              variant="dark"
              onDismiss={() => setInsightPanelOpen(false)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.16em", textTransform: "uppercase", color: "#9A958A" }}>{children}</div>;
}

// Header stat + expandable roster (#1). Click to reveal each viewer's name and
// slide number; the breakdown is computed against the presenter's current slide.
function PresenceStat({
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
      <button
        onClick={() => onOpenChange(!open)}
        title="Show who's watching"
        aria-expanded={open}
        style={{
          background: open ? "rgba(255,255,255,0.08)" : "transparent",
          border: "1px solid rgba(255,255,255,0.14)",
          color: "#E7E4DC",
          fontFamily: "inherit",
          fontSize: 13,
          fontWeight: 500,
          cursor: "pointer",
          padding: "5px 10px",
          borderRadius: 8,
          whiteSpace: "nowrap",
        }}
      >
        👁 {watching} watching
        {watching > 0 && (
          <span style={{ color: "#9A958A", fontWeight: 400 }}>
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
            left: 0,
            zIndex: 60,
            minWidth: 230,
            maxHeight: 320,
            overflowY: "auto",
            padding: "10px 12px",
            borderRadius: 12,
            background: "#2B2928",
            border: "1px solid rgba(255,255,255,0.14)",
            boxShadow: "0 18px 40px -20px rgba(0,0,0,0.7)",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {viewers.length === 0 ? (
            <div style={{ color: "#9A958A", fontSize: 12 }}>No one watching yet.</div>
          ) : (
            viewers.map((v, i) => (
              <div key={`${v.name}-${i}`} style={{ display: "flex", justifyContent: "space-between", gap: 14, fontSize: 12.5 }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.name}</span>
                <span style={{ color: "#9A958A", whiteSpace: "nowrap" }}>
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

// Persistent "help" meter (#2): decaying counts of viewers who feel lost / want
// you to slow down. Amber/red so it catches the eye; clears as counts hit 0.
function HelpMeter({ lost, slow }: { lost: number; slow: number }) {
  if (lost <= 0 && slow <= 0) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {lost > 0 && (
        <span style={helpChip("#FF6B4A", "rgba(181,51,31,0.22)", "rgba(255,107,74,0.5)")}>
          ❓ {lost} feel{lost === 1 ? "s" : ""} lost
        </span>
      )}
      {slow > 0 && (
        <span style={helpChip("#F0B24A", "rgba(201,138,46,0.2)", "rgba(240,178,74,0.5)")}>
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
    height: 28,
    padding: "0 12px",
    borderRadius: 999,
    background: bg,
    color: fg,
    border: `1px solid ${border}`,
    fontSize: 12.5,
    fontWeight: 600,
    whiteSpace: "nowrap",
    boxShadow: `0 0 0 3px ${bg}`,
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
    <div style={{ display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" }}>
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
      {error && <span style={{ fontSize: 11.5, color: "#FF8A6B", fontWeight: 500 }}>{error}</span>}
    </div>
  );
}

function checkBtn(muted: boolean): React.CSSProperties {
  return {
    height: 28,
    padding: "0 11px",
    borderRadius: 999,
    border: "1px solid rgba(240,178,74,0.5)",
    background: "rgba(240,178,74,0.14)",
    color: "#F0C97E",
    cursor: muted ? "default" : "pointer",
    fontFamily: "inherit",
    fontSize: 12,
    fontWeight: 600,
    whiteSpace: "nowrap",
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
  right: 12,
  padding: "4px 11px",
  borderRadius: 999,
  background: "rgba(191,224,72,0.92)",
  color: "#1B1B20",
  fontSize: 12,
  fontWeight: 700,
};

function btn(bg: string, fg: string): React.CSSProperties {
  return { height: 34, padding: "0 14px", borderRadius: 10, border: "none", cursor: "pointer", background: bg, color: fg, fontFamily: "inherit", fontSize: 13, fontWeight: 500 };
}

function navBtn(disabled: boolean): React.CSSProperties {
  return {
    height: 52,
    padding: "0 22px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.14)",
    cursor: disabled ? "default" : "pointer",
    background: disabled ? "#2A2827" : "rgba(255,255,255,0.08)",
    color: disabled ? "#7A7770" : "#F4F2EC",
    fontFamily: "inherit",
    fontSize: 16,
    fontWeight: 600,
  };
}

function ConsoleTimer() {
  const [elapsed, setElapsed] = useState(0);
  const [running, setRunning] = useState(true);
  const startRef = useRef<number | null>(null);
  const accRef = useRef(0);

  useEffect(() => {
    if (!running) return;
    if (startRef.current == null) startRef.current = performance.now();
    const id = window.setInterval(() => {
      const base = startRef.current ?? performance.now();
      setElapsed(accRef.current + (performance.now() - base));
    }, 250);
    return () => window.clearInterval(id);
  }, [running]);

  const mm = Math.floor(elapsed / 60000);
  const ss = Math.floor((elapsed % 60000) / 1000);
  const label = `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;

  const toggle = () => {
    if (running) {
      const base = startRef.current ?? performance.now();
      accRef.current += performance.now() - base;
      startRef.current = null;
    } else {
      startRef.current = performance.now();
    }
    setRunning((r) => !r);
  };
  const reset = () => {
    accRef.current = 0;
    startRef.current = running ? performance.now() : null;
    setElapsed(0);
  };

  const mini: React.CSSProperties = { border: "none", background: "rgba(255,255,255,0.12)", color: "#E7E4DC", width: 26, height: 26, borderRadius: 7, fontSize: 12, cursor: "pointer" };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontVariantNumeric: "tabular-nums" }}>
      <span style={{ fontSize: 18, fontWeight: 600 }}>{label}</span>
      <button onClick={toggle} title={running ? "Pause" : "Start"} style={mini}>{running ? "❚❚" : "▸"}</button>
      <button onClick={reset} title="Reset" style={mini}>↺</button>
    </span>
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

// Turn & Talk duration presets — synchronized countdowns, so no free-form input.
const ACTIVITY_PRESETS: { label: string; sec: number }[] = [
  { label: "2 min", sec: 120 },
  { label: "5 min", sec: 300 },
  { label: "10 min", sec: 600 },
];

// The Turn & Talk panel. No active activity → the compose form (prompt +
// duration presets + optional follow-up). Active → the prompt, a live MM:SS
// countdown (client-side from endsAt) and the Regroup button, which ends the
// activity on every screen at once (and, for a "poll" follow-up, opens the
// reviewed ✨ poll-draft flow — handled by the parent). Compose state is local;
// the parent owns the live activity (it rides the session poll).
function ActivityPanel({
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
    <div style={pollPanelWrap}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Label>Turn &amp; talk</Label>
        <button onClick={onDismiss} title="Hide panel" aria-label="Hide Turn & Talk panel" style={pollIconBtn}>
          ✕
        </button>
      </div>

      {activity ? (
        <div style={pollScroll}>
          <div style={{ fontSize: 15, fontWeight: 500, color: "#F4F2EC", lineHeight: 1.45, whiteSpace: "pre-wrap" }}>
            {activity.prompt}
          </div>
          <div style={activityCountdown(done)}>{done ? "Time's up" : `${mm}:${ss}`}</div>
          <div style={{ fontSize: 12, fontWeight: 500, color: done ? "#F0B24A" : "#9A958A" }}>
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
            style={{ ...btn("#BFE048", "#1B1B20"), height: 42, fontWeight: 600 }}
            title="End the activity on every screen at once"
          >
            {activity.followUp === "poll" ? "⏹ Regroup & draft poll" : "⏹ Regroup"}
          </button>
        </div>
      ) : (
        <div style={pollScroll}>
          <div>
            <FieldLabel>Prompt</FieldLabel>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Discuss with your neighbor…"
              maxLength={500}
              rows={3}
              style={pollTextarea}
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

          {error && <div style={pollErrorText}>{error}</div>}
          <button onClick={() => void start()} disabled={!canStart} style={launchBtn(canStart)}>
            {starting ? "Starting…" : "⏱ Start Turn & Talk"}
          </button>
        </div>
      )}
    </div>
  );
}

function activityCountdown(done: boolean): React.CSSProperties {
  return {
    fontVariantNumeric: "tabular-nums",
    fontSize: done ? 22 : 42,
    fontWeight: 600,
    letterSpacing: done ? "0" : "0.03em",
    lineHeight: 1.1,
    color: done ? "#F0B24A" : "#BFE048",
  };
}

function activityChoice(on: boolean): React.CSSProperties {
  return {
    flex: 1,
    height: 34,
    borderRadius: 9,
    border: on ? "1px solid #BFE048" : "1px solid rgba(255,255,255,0.16)",
    background: on ? "rgba(191,224,72,0.22)" : "rgba(255,255,255,0.06)",
    color: on ? "#D6E88A" : "#C9C5BC",
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: 12.5,
    fontWeight: 600,
    whiteSpace: "nowrap",
  };
}

// The poll panel (#3/#4). No live poll → the compose form (with the ✨ AI draft
// that FILLS it for review, never auto-launches). A live poll → results with a
// Reveal + Close. Compose state is local; the parent owns the live poll + tally.
function PollPanel({
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

// The tally's winning option (first wins a tie) — the branch the room chose.
function winningIndex(tally: number[], optionCount: number): number {
  let win = 0;
  for (let i = 1; i < optionCount; i++) {
    if ((tally[i] ?? 0) > (tally[win] ?? 0)) win = i;
  }
  return win;
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

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "#9A958A", marginBottom: 6 }}>
      {children}
    </div>
  );
}

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

const pollPanelWrap: React.CSSProperties = {
  flex: "0 0 330px",
  minWidth: 0,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: 14,
  borderRadius: 12,
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.12)",
};

const pollScroll: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

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

const pollTextarea: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "9px 11px",
  borderRadius: 9,
  resize: "vertical",
  border: "1px solid rgba(255,255,255,0.16)",
  background: "rgba(255,255,255,0.06)",
  color: "#F4F2EC",
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
    border: on ? "6px solid #BFE048" : "2px solid rgba(255,255,255,0.3)",
    background: on ? "#1B1B20" : "transparent",
  };
}

const pollIconBtn: React.CSSProperties = {
  width: 28,
  height: 28,
  flex: "0 0 auto",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.14)",
  background: "rgba(255,255,255,0.06)",
  color: "#C9C5BC",
  cursor: "pointer",
  fontSize: 14,
  lineHeight: 1,
  padding: 0,
};

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

function draftBtn(loading: boolean): React.CSSProperties {
  return {
    height: 40,
    borderRadius: 10,
    border: "1px solid rgba(191,224,72,0.5)",
    background: loading ? "rgba(191,224,72,0.12)" : "rgba(191,224,72,0.18)",
    color: "#D6E88A",
    cursor: loading ? "default" : "pointer",
    fontFamily: "inherit",
    fontSize: 13.5,
    fontWeight: 600,
    opacity: loading ? 0.8 : 1,
  };
}

function launchBtn(enabled: boolean): React.CSSProperties {
  return {
    height: 42,
    borderRadius: 10,
    border: "none",
    background: enabled ? "#BFE048" : "#3A3838",
    color: enabled ? "#1B1B20" : "#7A7770",
    cursor: enabled ? "pointer" : "default",
    fontFamily: "inherit",
    fontSize: 14,
    fontWeight: 600,
  };
}

const pollErrorText: React.CSSProperties = {
  fontSize: 12,
  color: "#FF8A6B",
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

const pollExplain: React.CSSProperties = {
  fontSize: 12,
  color: "#9A958A",
  lineHeight: 1.5,
  fontStyle: "italic",
  padding: "8px 10px",
  borderRadius: 8,
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.08)",
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

// Per-question drafted-answer state (#5). Local to the panel so it resets when the
// panel is closed (matching the poll compose form).
interface AiAnswerState {
  loading: boolean;
  open: boolean;
  answer?: string;
  error?: string;
}

// The presenter's Q&A panel (#5): a top-of-panel AI confusion digest, then the full
// queue (top-voted first; dismissed ones greyed but still listed). Per question:
// Answer, Dismiss/Restore, and a one-tap ✨ AI answer drafted from the current slide
// (collapsible so the presenter can verify before speaking). AI/digest state is local
// — the parent owns the queue and applies each action's returned list.
function QnaPanel({
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

function qnaStateTag(color: string): React.CSSProperties {
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
