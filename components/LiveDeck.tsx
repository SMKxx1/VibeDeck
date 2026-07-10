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
        const s = (await res.json()) as SessionState;
        lastLive = s.live;
        setSession(s);
        // Presenter windows sync with each other instantly via BroadcastChannel,
        // never via this poll — polling here would fight local navigation.
        if (role === "presenter") return;
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
                    <button onClick={() => setAutoFollow(true)} style={pill("#2C2A31", "#F4F2EC")} title="Jump to the presenter">
                      {behind} {behind === 1 ? "slide" : "slides"} behind · catch up
                    </button>
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
