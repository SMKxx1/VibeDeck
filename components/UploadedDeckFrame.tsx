import type { Deck } from "@/lib/types";

// Full-bleed viewer for an uploaded deck's OWN self-contained HTML, served from
// the isolated DECK_ORIGIN and framed here under a hard sandbox.
//
// This is deliberately NOT LiveDeck. LiveDeck wraps the one trusted first-party
// workshop deck and speaks a live-session postMessage protocol (role/goto/pins/
// heartbeat) with the framed engine — a bridge that assumes the framed content
// is cooperative and same-trust. Uploaded HTML is untrusted stored content, so
// it gets NONE of that: no bridge, no handshake, no postMessage of any kind.
//
// Sandbox rationale (each omission is load-bearing, not an oversight):
//   sandbox="allow-scripts"  — the deck runs its own JS engine, but with NO
//     `allow-same-origin`, so even though it's served from DECK_ORIGIN the frame
//     is forced into an opaque, origin-of-its-own context: it can't read cookies,
//     localStorage, or the DOM of THIS parent, and same-origin fetches from
//     inside it are treated cross-origin. This is the primary containment.
//   (no allow-top-navigation)   — untrusted content can't hijack the top frame
//     to redirect the user off-site.
//   (no allow-same-origin)      — see above; the whole point of the isolation.
//   allow="fullscreen"          — the only capability an artifact deck legitimately
//     needs; it's a Permissions-Policy grant, orthogonal to the sandbox trust bits.
//
// Phase 1 has no live-presenter sync for uploaded decks — they're self-contained
// artifacts, not the workshop's live-driven experience — so the presenter route
// renders this exact same frame (no presenter-only affordance yet).
export function UploadedDeckFrame({ deck }: { deck: Deck }) {
  // contentUrl is undefined when DECK_ORIGIN is unset. We can't guess an origin
  // for untrusted content, and we must never fall back to serving it from the
  // app's own origin (that would defeat the isolation entirely) — so surface a
  // neutral "unavailable" state rather than crash or leak the deck onto the
  // first-party origin.
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
    <div style={{ position: "fixed", inset: 0, background: "#ECEAE3" }}>
      <iframe
        src={deck.contentUrl}
        title={deck.title}
        sandbox="allow-scripts"
        allow="fullscreen"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          border: 0,
          display: "block",
        }}
      />
    </div>
  );
}
