"use client";

// Full-bleed viewer for an uploaded deck's OWN self-contained HTML, served from
// the isolated DECK_ORIGIN and framed here under a hard sandbox.
//
// This is NOT LiveDeck. LiveDeck wraps the one trusted first-party workshop deck
// and speaks a full two-way live-session protocol with it (role/goto/pins/
// heartbeat) — a bridge that assumes the framed content is cooperative and
// same-trust. Uploaded HTML is UNTRUSTED stored content, so it never gets that.
//
// What it DOES get (new in Phase 2): a RECEIVE-ONLY bridge + the AI tutor.
// Uploaded decks are now served with the shared runtime injected server-side,
// which includes the same live bridge.js. That bridge reports slide changes to
// us (index/total/label) so the deck can (a) show its position and (b) ground
// the AI sidebar in whatever slide is on screen — the product's signature
// feature. We only OBSERVE; the deck drives its own navigation (keyboard/click
// handled by its own runtime). There is no live-presenter sync for uploaded
// decks in Phase 2 — they're single-viewer artifacts.
//
// Why this is safe for untrusted content — the trust model differs from LiveDeck
// on two axes, both load-bearing:
//
//   1. IDENTITY, not origin. A sandboxed frame with NO `allow-same-origin` runs
//      in an opaque origin, so `event.origin` is the literal string "null" —
//      useless (and checking it would reject every real message). The real
//      authenticator is `event.source === iframeRef.current.contentWindow`:
//      the message object-identity of OUR frame's window, which untrusted code
//      elsewhere on the page cannot forge. We accept a message ONLY when that
//      holds AND it carries the `source:"deck"` marker; everything else is
//      dropped. (LiveDeck trusts the `source:"deck"` marker alone — fine for a
//      first-party deck, too weak here.)
//
//   2. RECEIVE-ONLY for data. The ONLY message we ever post to the frame is the
//      EMPTY `{ type:"deck:report" }` — a control ping that asks the deck to
//      re-emit its current slide (covers the boot race where the deck's first
//      report fires before our listener attaches). We NEVER post deck:role,
//      deck:pins, deck:goto, deck:advance, or any session/pin/navigation data:
//      a sandboxed deck can navigate ITSELF to an attacker origin, and because
//      we can't target a specific origin at an opaque frame (targetOrigin must
//      be "*"), any data-bearing send would then leak to wherever it went. An
//      empty control ping carries nothing worth leaking.
//
// Sandbox rationale (each omission is load-bearing, not an oversight):
//   sandbox="allow-scripts"  — the deck runs its own JS engine + bridge, but
//     with NO `allow-same-origin`, so even though it's served from DECK_ORIGIN
//     the frame is forced into an opaque, origin-of-its-own context: it can't
//     read cookies, localStorage, or the DOM of THIS parent, and same-origin
//     fetches from inside it are treated cross-origin. This is the primary
//     containment — do NOT add allow-same-origin.
//   (no allow-top-navigation)   — untrusted content can't hijack the top frame
//     to redirect the user off-site.
//   (no allow-same-origin)      — see above; the whole point of the isolation.
//   allow="fullscreen"          — the only capability an artifact deck legitimately
//     needs; it's a Permissions-Policy grant, orthogonal to the sandbox trust bits.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Deck } from "@/lib/types";
import { LiveChat } from "./LiveChat";
import { useFullscreen } from "@/lib/useFullscreen";

// Reuse the workshop's stored viewer name so the AI greeting is personal for
// anyone who already named themselves. An uploaded deck is a single-viewer
// artifact, so there's no name gate here — stored name, or a neutral fallback.
const NAME_KEY = "presentation:name";

// Only the fields we OBSERVE from the deck's `slidechange`. We don't track
// nextLabel/notes/reason — those exist for the presenter/sync machinery an
// uploaded deck doesn't have.
interface DeckState {
  index: number;
  total: number;
  label: string;
}

export function UploadedDeckFrame({ deck }: { deck: Deck }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const { isFullscreen, toggle } = useFullscreen();

  const [state, setState] = useState<DeckState>({ index: 0, total: 0, label: "" });
  const [chatOpen, setChatOpen] = useState(false);
  const [name, setName] = useState<string | null>(null);

  // The ONE and ONLY message we ever post to an untrusted frame: an EMPTY
  // control ping asking the deck to re-emit its current slide. It carries no
  // data, and targetOrigin MUST be "*" (an opaque-origin frame has no specific
  // origin to target). See the receive-only rationale in the header comment.
  const requestReport = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage({ type: "deck:report" }, "*");
  }, []);

  // Load the stored viewer name (if the visitor already named themselves in the
  // workshop). Best-effort — localStorage can throw in locked-down contexts.
  useEffect(() => {
    try {
      const n = localStorage.getItem(NAME_KEY);
      if (n) setName(n);
    } catch {
      /* ignore */
    }
  }, []);

  // Receive-only bridge: track the current slide from the deck's `slidechange`.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = (event.data ?? {}) as { source?: string; type?: string } & Partial<DeckState>;
      // SECURITY GUARD — accept a message ONLY from our OWN frame's window
      // (object identity, unforgeable) AND carrying the deck marker. We do NOT
      // check event.origin: it's the string "null" for an opaque-origin sandbox,
      // so checking it would reject everything. See header comment §1.
      if (!(event.source === iframeRef.current?.contentWindow && data.source === "deck")) return;
      if (data.type === "slidechange") {
        setState({
          index: data.index ?? 0,
          total: data.total ?? 0,
          label: data.label ?? "",
        });
      }
      // `ready`/`activity` are ignored — an uploaded deck has no role handshake
      // to push on ready, and no auto-hiding presenter overlay to wake.
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Cover the boot race: the deck may fire its first `slidechange` before this
  // component's listener attached (or before the bridge finished booting). The
  // iframe's onLoad also pings once, but keep asking until we actually have a
  // slide count — mirrors how LiveDeck polls deck:report.
  useEffect(() => {
    if (!deck.contentUrl || state.total > 0) return;
    requestReport();
    const id = window.setInterval(requestReport, 350);
    return () => window.clearInterval(id);
  }, [deck.contentUrl, state.total, requestReport]);

  // contentUrl is undefined when DECK_ORIGIN is unset. We can't guess an origin
  // for untrusted content, and we must never fall back to serving it from the
  // app's own origin (that would defeat the isolation entirely) — so surface a
  // neutral "unavailable" state rather than crash or leak the deck onto the
  // first-party origin. (Hooks above run unconditionally so this early return
  // never changes hook order for a given deck.)
  if (!deck.contentUrl) {
    return (
      <main
        style={{
          minHeight: "100dvh",
          display: "grid",
          placeItems: "center",
          padding: "2rem",
          textAlign: "center",
        }}
      >
        <p style={{ opacity: 0.7, fontSize: "1.1rem" }}>
          This deck can’t be displayed right now.
        </p>
      </main>
    );
  }

  return (
    <div ref={stageRef} style={{ position: "fixed", inset: 0, background: "#ECEAE3", display: "flex" }}>
      <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
        <iframe
          ref={iframeRef}
          src={deck.contentUrl}
          title={deck.title}
          sandbox="allow-scripts"
          allow="fullscreen"
          // Ping for the current slide once the frame has loaded, in case the
          // deck's first report fired before this frame's listener was live.
          onLoad={requestReport}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            border: 0,
            display: "block",
          }}
        />

        {/* top-right control cluster: fullscreen + the AI tutor toggle */}
        <div
          style={{
            position: "absolute",
            top: 14,
            right: 16,
            zIndex: 40,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <FullscreenButton active={isFullscreen} onClick={() => void toggle(stageRef.current)} />
          <ChatButton open={chatOpen} onClick={() => setChatOpen((o) => !o)} />
        </div>
      </div>

      {chatOpen && (
        <LiveChat
          slug={deck.slug}
          slideIndex={state.index}
          slideLabel={state.label}
          name={name ?? "Viewer"}
          onClose={() => setChatOpen(false)}
        />
      )}
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
