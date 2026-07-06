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

  const sessionRef = useRef(session);
  sessionRef.current = session;
  const deckRef = useRef(deck);
  deckRef.current = deck;
  const channelRef = useRef<SyncChannel | null>(null);
  const previewIdxRef = useRef(-1);

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

  // Boot-race: keep asking the main deck for its state until we have it.
  useEffect(() => {
    if (deck.total > 0) return;
    sendMain({ type: "deck:report" });
    const id = window.setInterval(() => sendMain({ type: "deck:report" }), 350);
    return () => window.clearInterval(id);
  }, [deck.total, sendMain]);

  const atStart = deck.index <= 0;
  const atEnd = deck.total > 0 && deck.index >= deck.total - 1;

  return (
    <div style={{ position: "fixed", inset: 0, background: "#22201F", color: "#F4F2EC", fontFamily: '"Outfit", system-ui, sans-serif', display: "flex", flexDirection: "column" }}>
      {/* header */}
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "12px 20px", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.16em", textTransform: "uppercase", color: "#BFE048" }}>Presenter</span>
          <span style={{ fontSize: 15, fontWeight: 500 }}>{title}</span>
          <span style={{ fontSize: 13, color: "#9A958A" }}>
            slide {deck.index + 1}{deck.total ? ` / ${deck.total}` : ""} · viewers unlocked → {session.max + 1}
          </span>
        </div>
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
          <div style={{ flex: 1, minHeight: 0, overflow: "auto", borderRadius: 12, padding: "14px 16px", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", fontSize: 15, lineHeight: 1.6, color: "#E7E4DC" }}>
            {deck.notes || <span style={{ color: "#7A7770" }}>No notes for this slide.</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.16em", textTransform: "uppercase", color: "#9A958A" }}>{children}</div>;
}

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
