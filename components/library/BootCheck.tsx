"use client";

// Post-upload boot check — moved verbatim from components/DeckLibrary.tsx.

import { useEffect, useState } from "react";
import { noticeStyle } from "./shared";

// After a deck is stored, prove it actually RUNS: mint a signed preview URL, load
// the real cross-origin /d-content deck in a HIDDEN, hard-sandboxed iframe, and
// wait for the shared runtime's bridge to report a slide count. Server-side
// validation checks structure; this is the "does it really boot in a browser"
// confirmation that structural checks can't give. Advisory only — the deck is
// already stored (unpublished), so a failure here is a warning, not a hard error.
//
// SECURITY — this reuses UploadedDeckFrame's trust model verbatim (see its header
// §1), and the two invariants below are NON-NEGOTIABLE:
//   1. sandbox="allow-scripts" with NO allow-same-origin → the deck runs in an
//      opaque origin, contained exactly as it is for real viewers. `src` is the
//      REAL /d-content URL. We NEVER use srcdoc, a blob: URL, or a same-origin
//      document to load the deck HTML — any of those would execute untrusted
//      uploaded HTML on the APP (dashboard) origin, recreating the very same-
//      origin-XSS hole the separate DECK_ORIGIN mechanism exists to prevent.
//   2. We accept a message ONLY when event.source === our iframe's contentWindow
//      (unforgeable window identity) AND event.data.source === "deck". We do NOT
//      check event.origin — it's the literal string "null" for an opaque-origin
//      sandbox, so checking it would reject every real message.
type BootState =
  | { kind: "checking" }
  | { kind: "unavailable"; reason: string }
  | { kind: "runs"; total: number }
  | { kind: "failed" };

// The bridge fires `ready` (no total) then its first `slidechange` (with total)
// within a few frames of boot; 6s is generous headroom for a slow cold start
// while staying short enough that "didn't boot" feels prompt.
const BOOT_TIMEOUT_MS = 6000;

export function BootCheck({ slug }: { slug: string }) {
  const [boot, setBoot] = useState<BootState>({ kind: "checking" });

  useEffect(() => {
    // One `settled` guard + one cleanup closure shared by every async exit, so
    // the listener / iframe / timer are torn down exactly once — whether we
    // succeed, time out, or the panel unmounts mid-check (React runs the returned
    // fn then). No leaked iframes or dangling message listeners.
    let settled = false;
    let iframe: HTMLIFrameElement | null = null;
    let timer: number | undefined;
    let onMessage: ((e: MessageEvent) => void) | null = null;

    function cleanup() {
      if (timer !== undefined) window.clearTimeout(timer);
      if (onMessage) window.removeEventListener("message", onMessage);
      if (iframe && iframe.parentNode) iframe.parentNode.removeChild(iframe);
      timer = undefined;
      onMessage = null;
      iframe = null;
    }

    void (async () => {
      // 1. Mint the signed preview URL (same-origin fetch → cookie + Origin sent
      //    automatically, so the presenter gate + CSRF check pass). A non-200
      //    (e.g. 503 deck_origin_unset) means the live check just isn't available
      //    — NOT that the deck is bad; it's already stored. Degrade to a neutral
      //    note, never an error.
      let url: string | undefined;
      try {
        const res = await fetch(`/api/admin/decks/${slug}/preview`);
        const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
        if (!res.ok || !data.url) {
          if (!settled) {
            settled = true;
            setBoot({
              kind: "unavailable",
              reason: data.error === "deck_origin_unset" ? "deck origin not configured" : "the live check isn't available",
            });
          }
          return;
        }
        url = data.url;
      } catch {
        if (!settled) {
          settled = true;
          setBoot({ kind: "unavailable", reason: "the live check isn't available" });
        }
        return;
      }
      if (settled) return; // panel closed while the token minted

      // 2. Hidden, hard-sandboxed iframe pointed at the REAL cross-origin deck.
      //    allow-scripts WITHOUT allow-same-origin = opaque origin, the exact
      //    containment real viewers get. `src` is the /d-content URL — never
      //    srcdoc/blob: (that would run untrusted HTML on the app origin).
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("aria-hidden", "true");
      frame.setAttribute("tabindex", "-1");
      frame.title = "Deck boot check";
      frame.style.cssText = "position:absolute; left:-9999px; top:0; width:0; height:0; border:0; opacity:0; pointer-events:none;";
      frame.src = url;
      // onLoad nudge: the deck may fire its first report before our listener is
      // live (boot race) — ask it to re-emit. Empty control ping, targetOrigin
      // "*" (an opaque frame has no specific origin to target). Mirrors
      // UploadedDeckFrame's requestReport.
      frame.addEventListener("load", () => {
        try {
          frame.contentWindow?.postMessage({ type: "deck:report" }, "*");
        } catch {
          /* ignore */
        }
      });
      iframe = frame;

      onMessage = (e: MessageEvent) => {
        const d = (e.data ?? {}) as { source?: string; type?: string; total?: number };
        // SECURITY GUARD — our OWN frame's window (unforgeable object identity)
        // AND the deck marker. NOT event.origin (it's "null" for the sandbox).
        if (!(e.source === frame.contentWindow && d.source === "deck")) return;
        // SUCCESS: a slidechange (or ready) reporting a real slide count. The
        // bridge's `ready` carries no total, so in practice this trips on the
        // first slidechange — exactly the "booted and enumerated slides" proof.
        if ((d.type === "slidechange" || d.type === "ready") && typeof d.total === "number" && d.total > 0) {
          if (!settled) {
            settled = true;
            setBoot({ kind: "runs", total: d.total });
          }
          cleanup();
        }
      };
      window.addEventListener("message", onMessage);
      document.body.appendChild(frame);

      // 3. Bounded wait: nothing reported a slide count in time → the deck didn't
      //    boot under the runtime. Advisory warning — it's still stored.
      timer = window.setTimeout(() => {
        if (!settled) {
          settled = true;
          setBoot({ kind: "failed" });
        }
        cleanup();
      }, BOOT_TIMEOUT_MS);
    })();

    return () => {
      settled = true;
      cleanup();
    };
  }, [slug]);

  if (boot.kind === "checking") {
    return <div style={noticeStyle("muted")}>Checking it runs in a browser…</div>;
  }
  if (boot.kind === "unavailable") {
    // The deck stored fine; the live check just couldn't run. Neutral, not an error.
    return <div style={noticeStyle("muted")}>Preview unavailable ({boot.reason}) — the deck is stored either way.</div>;
  }
  if (boot.kind === "runs") {
    return (
      <div style={noticeStyle("ok")}>
        Runs ✓ — {boot.total} {boot.total === 1 ? "slide" : "slides"}
      </div>
    );
  }
  return (
    <div style={noticeStyle("warn")}>
      This deck didn’t boot in a browser — check the structure and use Replace.
    </div>
  );
}
