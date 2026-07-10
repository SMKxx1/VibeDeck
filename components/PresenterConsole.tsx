"use client";

// The presenter view — a dedicated window (opened from the deck's "Presenter
// view" button) that shows the CURRENT slide, a live preview of the NEXT slide,
// the speaker notes, and a timer, with prev/next + reset-lock. It DRIVES the
// live session (so viewers + the projector follow) and heartbeats to keep the
// session "live". Meant for the presenter's screen while the projector shows the
// clean deck (open "/" there).

import { useCallback, useEffect, useRef, useState } from "react";
import { createSyncChannel, type SyncChannel } from "@/lib/sync";

const POLL_MS = Number(process.env.NEXT_PUBLIC_SESSION_POLL_MS) || 2000;
// Roster + backchannel polling for the live-room panels (#1/#2). Every ~4s, and
// far slower when the tab is hidden so a backgrounded console doesn't hammer Redis.
const PRESENCE_POLL_MS = 4_000;
const PRESENCE_HIDDEN_MS = 30_000;

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
}

// The full poll record (#3) — the presenter sees the correct answer + the live
// tally, unlike the viewer-safe projection delivered on /api/session.
interface Poll {
  id: string;
  question: string;
  options: string[];
  correctIndex: number | null;
  revealed: boolean;
  tally: number[] | null;
  total: number | null;
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
    async (opts: { index?: number; reset?: boolean; heartbeat?: boolean }) => {
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
  const drive = useCallback(
    (index: number) => {
      channelRef.current?.post({ type: "state", index });
      void post({ index });
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
        setSession((await res.json()) as SessionState);
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
  }, [slug]);

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
        // Fold the live-poll tally (#3) into the same tick as presence + reactions.
        const [pRes, sRes, qRes] = await Promise.all([
          fetch(`/api/presence?slug=${enc}`, { cache: "no-store", signal: ctrl.signal }),
          fetch(`/api/signal?slug=${enc}`, { cache: "no-store", signal: ctrl.signal }),
          fetch(`/api/poll?slug=${enc}`, { cache: "no-store", signal: ctrl.signal }),
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
        <HelpMeter lost={help.lost} slow={help.slow} />
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
          <ConsoleTimer />
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
          <div style={{ display: "flex", gap: 12 }}>
            <button onClick={() => sendMain({ type: "deck:advance", dir: -1 })} disabled={atStart} style={navBtn(atStart)}>
              ‹ Prev
            </button>
            <button onClick={() => sendMain({ type: "deck:advance", dir: 1 })} disabled={atEnd} style={{ ...navBtn(atEnd), flex: 1, background: atEnd ? "#3A3838" : "#BFE048", color: atEnd ? "#7A7770" : "#1B1B20" }}>
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
            reduceMotion={reduceMotion}
            onLaunch={openPollAction}
            onReveal={revealPollAction}
            onClose={closePollAction}
            onDismiss={() => setPollPanelOpen(false)}
          />
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

// The poll panel (#3/#4). No live poll → the compose form (with the ✨ AI draft
// that FILLS it for review, never auto-launches). A live poll → results with a
// Reveal + Close. Compose state is local; the parent owns the live poll + tally.
function PollPanel({
  poll,
  tally,
  total,
  slug,
  index,
  reduceMotion,
  onLaunch,
  onReveal,
  onClose,
  onDismiss,
}: {
  poll: Poll | null;
  tally: number[];
  total: number;
  slug: string;
  index: number;
  reduceMotion: boolean;
  onLaunch: (question: string, options: string[], correctIndex: number | null) => Promise<boolean>;
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
  const draftCtrlRef = useRef<AbortController | null>(null);

  useEffect(() => () => draftCtrlRef.current?.abort(), []);

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
        <Label>{poll ? "Live poll" : "New poll"}</Label>
        <button onClick={onDismiss} title="Hide panel" aria-label="Hide poll panel" style={pollIconBtn}>
          ✕
        </button>
      </div>

      {poll ? (
        <PollResults poll={poll} tally={tally} total={total} reduceMotion={reduceMotion} onReveal={onReveal} onClose={onClose} />
      ) : (
        <div style={pollScroll}>
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
function PollResults({
  poll,
  tally,
  total,
  reduceMotion,
  onReveal,
  onClose,
}: {
  poll: Poll;
  tally: number[];
  total: number;
  reduceMotion: boolean;
  onReveal: () => void;
  onClose: () => void;
}) {
  const max = Math.max(1, ...(tally.length ? tally : [0]));
  return (
    <div style={pollScroll}>
      <div style={{ fontSize: 15, fontWeight: 500, color: "#F4F2EC", lineHeight: 1.4 }}>{poll.question}</div>
      <div style={{ fontSize: 12, fontWeight: 500, color: poll.revealed ? "#BFE048" : "#9A958A" }}>
        {poll.revealed ? "Revealed to the room" : "Live — collecting votes"} · {total} vote{total === 1 ? "" : "s"}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {poll.options.map((opt, i) => {
          const count = tally[i] ?? 0;
          const correct = poll.correctIndex === i;
          const pct = Math.round((count / max) * 100);
          const share = total > 0 ? Math.round((count / total) * 100) : 0;
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
                  {poll.revealed && correct && <span style={presTag}>✓ correct</span>}
                </span>
                <span style={{ fontWeight: 600, flex: "0 0 auto" }}>
                  {count}
                  {total > 0 ? ` · ${share}%` : ""}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 2 }}>
        {!poll.revealed && (
          <button onClick={onReveal} style={{ ...btn("#BFE048", "#1B1B20"), flex: 1, height: 40, fontWeight: 600 }}>
            Reveal to room
          </button>
        )}
        <button onClick={onClose} style={{ ...btn("rgba(255,255,255,0.1)", "#F4F2EC"), flex: poll.revealed ? 1 : "0 0 auto", height: 40 }}>
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
