"use client";

// Renders a self-contained HTML deck (its own engine + styles, served from
// /public) full-bleed in an iframe, so it looks and behaves EXACTLY like the
// imported design. Used for decks with an `embedUrl` (see lib/types Deck).
//
// The only app chrome is a subtle "Library" link back home. We focus the iframe
// on mount so the deck's own keyboard navigation (←/→, Space, etc.) works right
// away without a click.

import { useEffect, useRef } from "react";
import Link from "next/link";

export function EmbeddedDeck({ url, title }: { url: string; title: string }) {
  const ref = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    // Give the iframe document a moment to boot its engine, then hand it focus.
    const id = window.setTimeout(() => ref.current?.focus(), 300);
    return () => window.clearTimeout(id);
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#ECEAE3" }}>
      <iframe
        ref={ref}
        src={url}
        title={title}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          border: 0,
          display: "block",
        }}
        allow="fullscreen"
      />
      <Link
        href="/"
        aria-label="Back to library"
        title="Back to library"
        style={{
          position: "fixed",
          top: 14,
          right: 16,
          zIndex: 50,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          height: 34,
          padding: "0 14px",
          borderRadius: 12,
          fontFamily: '"Outfit", system-ui, sans-serif',
          fontSize: 13,
          fontWeight: 500,
          letterSpacing: "0.01em",
          color: "#2C2A31",
          textDecoration: "none",
          background: "rgba(255,255,255,0.62)",
          border: "1px solid rgba(255,255,255,0.85)",
          backdropFilter: "blur(14px)",
          WebkitBackdropFilter: "blur(14px)",
          boxShadow: "0 6px 18px -12px rgba(60,55,45,0.4)",
        }}
      >
        <span aria-hidden="true">←</span> Library
      </Link>
    </div>
  );
}
