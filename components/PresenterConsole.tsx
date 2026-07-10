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

  const sessionRef = useRef(session);
  sessionRef.current = session;
  const deckRef = useRef(deck);
  deckRef.current = deck;
  const channelRef = useRef<SyncChannel | null>(null);
  const previewIdxRef = useRef(-1);

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
        const [pRes, sRes] = await Promise.all([
          fetch(`/api/presence?slug=${enc}`, { cache: "no-store", signal: ctrl.signal }),
          fetch(`/api/signal?slug=${enc}`, { cache: "no-store", signal: ctrl.signal }),
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
