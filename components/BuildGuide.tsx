"use client";

// The "Build a deck with AI" guide (the /build page body). Presenter-facing.
// Two jobs: (1) hand over the exact prompt to paste into an AI so it emits a
// deck that passes upload, and (2) a self-check checklist that mirrors the
// server validator (lib/deck-validator.ts) 1:1 so a presenter can eyeball a
// deck before uploading it. Styled to the warm "Solis" palette the dashboard
// uses (paper #ECEAE3 + dot grid, Outfit via the body font, frosted cards).

import { useState } from "react";
import Link from "next/link";

// One checklist row. `level` mirrors how the validator treats the rule:
//  • "enforced"    — a hard reject on upload (issues[] non-empty). Must pass.
//  • "recommended" — a non-fatal warning; the deck still uploads (warnings[]).
//  • "optional"    — legal to omit entirely, but if present it must be well-formed.
// Keeping this distinction visible is the point of "mirror the validator 1:1":
// only the missing-data-label rule is a warning; everything else is a reject.
type Level = "enforced" | "recommended" | "optional";
interface Check {
  title: string;
  detail: string;
  level: Level;
}

// Each row maps to a concrete rule in lib/deck-validator.ts (or, for size, the
// upload route's 2 MB cap). No rule here that the platform doesn't actually
// check; no checked rule left out.
const CHECKLIST: Check[] = [
  {
    title: "Exactly one <deck-stage> wraps the whole deck",
    detail: "Zero or more than one is rejected. width / height attributes are optional.",
    level: "enforced",
  },
  {
    title: "Every slide is a direct <section> child of <deck-stage>",
    detail: "A <section> nested inside another element is not counted as a slide.",
    level: "enforced",
  },
  {
    title: "Between 1 and 300 slides",
    detail: "An empty <deck-stage>, or more than 300 direct <section> slides, is rejected.",
    level: "enforced",
  },
  {
    title: "Each slide <section> has a data-label title",
    detail:
      "Optional but recommended — a slide with no data-label still uploads, it just shows no title in the presenter view or navigation.",
    level: "recommended",
  },
  {
    title: "All CSS and JS is inline; no external <script src>",
    detail:
      "Inline <style>/<script> only. Any <script src=\"…\"> is rejected. External CDNs, fonts, and images are blocked by the deck CSP anyway.",
    level: "enforced",
  },
  {
    title: "No slide runtime or framework of your own",
    detail: "VibeDeck injects the slide runtime automatically at display time — don't add reveal.js or an engine script.",
    level: "enforced",
  },
  {
    title: "If present, the AI manifest is strictly valid",
    detail:
      "<script type=\"application/json\" id=\"vibedeck-context\"> must be a JSON array: 0-based in-range index, no duplicates, label ≤ 200 chars, aiContext ≤ 8000 chars, no more entries than slides. Malformed → the whole deck is rejected. Omitting it entirely is fine.",
    level: "optional",
  },
  {
    title: "The whole HTML file is ≤ 2 MB",
    detail: "Including any inline images. Larger uploads are refused.",
    level: "enforced",
  },
];

// Level chip — a small, muted pill so the checklist reads calmly rather than
// like a form with error states. Dark ink for the hard rules, lime for the
// recommended one, neutral for optional.
function levelChip(level: Level): { label: string; bg: string; color: string } {
  if (level === "recommended") return { label: "Recommended", bg: "#BFE048", color: "#2C2A31" };
  if (level === "optional") return { label: "Optional", bg: "rgba(40,38,32,0.08)", color: "#6E6A62" };
  return { label: "Enforced", bg: "#2C2A31", color: "#F4F2EC" };
}

export function BuildGuide({ prompt }: { prompt: string }) {
  // copied: brief confirmation after a successful copy. copyError: the clipboard
  // API can reject (permissions / insecure context) — surface a fallback hint
  // rather than silently doing nothing.
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  async function copyPrompt() {
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError(true);
    }
  }

  const card: React.CSSProperties = {
    background: "rgba(255,255,255,0.5)",
    border: "1px solid rgba(255,255,255,0.72)",
    backdropFilter: "blur(16px)",
    WebkitBackdropFilter: "blur(16px)",
    boxShadow: "0 10px 28px -16px rgba(60,55,45,0.4)",
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        padding: "34px 38px 60px",
        display: "flex",
        justifyContent: "center",
        // Same warm paper + dot-grid backdrop as the dashboard.
        background: "#ECEAE3",
        backgroundImage: "radial-gradient(rgba(40,38,32,0.045) 1px, transparent 1.4px)",
        backgroundSize: "22px 22px",
      }}
    >
      <div style={{ width: "100%", maxWidth: 880 }}>
        {/* ============ TOP BAR ============ */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24, marginBottom: 34 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 13, userSelect: "none" }}>
            <div
              style={{
                flex: "0 0 auto",
                width: 42,
                height: 42,
                borderRadius: 13,
                background: "rgba(255,255,255,0.55)",
                border: "1px solid rgba(255,255,255,0.75)",
                backdropFilter: "blur(14px)",
                WebkitBackdropFilter: "blur(14px)",
                boxShadow: "0 6px 18px -10px rgba(60,55,45,0.4)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="#3A3A40" strokeWidth={1.1}>
                <circle cx="10" cy="10" r="3.1" />
                <g strokeLinecap="round">
                  <path d="M10 1.4V4M10 16v2.6M1.4 10H4M16 10h2.6M3.9 3.9l1.8 1.8M14.3 14.3l1.8 1.8M16.1 3.9l-1.8 1.8M5.7 14.3l-1.8 1.8" />
                </g>
              </svg>
            </div>
            <div style={{ fontSize: 19, fontWeight: 500, letterSpacing: "0.01em", color: "#262229" }}>Solis</div>
          </div>

          <Link
            href="/dashboard"
            className="bg-back"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              height: 40,
              padding: "0 16px",
              borderRadius: 12,
              textDecoration: "none",
              color: "#4A4750",
              fontSize: 13.5,
              fontWeight: 400,
              ...card,
            }}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
              <path d="M9.5 3.5L5 8l4.5 4.5" />
            </svg>
            Back to library
          </Link>
        </div>

        {/* ============ INTRO ============ */}
        <div style={{ marginBottom: 26 }}>
          <div style={{ fontSize: 12, fontWeight: 500, letterSpacing: "0.22em", textTransform: "uppercase", color: "#9A958A", marginBottom: 14 }}>
            Build
          </div>
          <h1 style={{ fontSize: 40, fontWeight: 300, lineHeight: 1.08, letterSpacing: "-0.025em", margin: 0, color: "#262229" }}>
            Build a deck with AI
          </h1>
          <p style={{ fontSize: 16, fontWeight: 300, lineHeight: 1.55, color: "#6E6A62", margin: "16px 0 0", maxWidth: "58ch" }}>
            Copy the prompt below, paste it into your AI assistant, and add one line — “make me a deck about photosynthesis.”
            You’ll get back a single self-contained HTML file. Check it against the list, then upload it from the library with{" "}
            <span style={{ color: "#4A4750", fontWeight: 400 }}>New deck</span>.
          </p>
        </div>

        {/* ============ PROMPT ============ */}
        <div style={{ ...card, borderRadius: 18, padding: 20, marginBottom: 26 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 500, color: "#2C2932" }}>The author prompt</div>
              <div style={{ fontSize: 12.5, fontWeight: 300, color: "#8A857C", marginTop: 2 }}>
                Everything an AI needs to emit a conforming deck.
              </div>
            </div>
            <button
              type="button"
              onClick={copyPrompt}
              className="bg-copy"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                height: 38,
                padding: "0 16px",
                borderRadius: 11,
                border: "none",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 13.5,
                fontWeight: 500,
                whiteSpace: "nowrap",
                // Flip to the lime "done" fill on success so the confirmation is
                // unmistakable at a glance; dark ink chip otherwise.
                background: copied ? "#BFE048" : "#2C2A31",
                color: copied ? "#2C2A31" : "#F4F2EC",
                transition: "background .15s, color .15s",
              }}
            >
              {copied ? (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 8.5L6.5 12L13 4.5" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
                  <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" />
                  <path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
                </svg>
              )}
              {copied ? "Copied" : "Copy prompt"}
            </button>
          </div>

          {copyError && (
            <div style={{ fontSize: 12.5, color: "#C23B27", marginBottom: 10 }}>
              Couldn’t copy automatically — select the text below and copy it manually.
            </div>
          )}

          {/* The prompt verbatim. Monospace + pre-wrap so it reads as literal text
              to paste; capped height with its own scroll so it never dominates the
              page. */}
          <pre
            style={{
              margin: 0,
              maxHeight: 380,
              overflow: "auto",
              padding: 16,
              borderRadius: 12,
              background: "rgba(40,38,32,0.05)",
              border: "1px solid rgba(60,55,45,0.12)",
              fontFamily: "var(--font-mono)",
              fontSize: 12.5,
              lineHeight: 1.55,
              color: "#3A3730",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {prompt}
          </pre>
        </div>

        {/* ============ CHECKLIST ============ */}
        <div style={{ ...card, borderRadius: 18, padding: 20 }}>
          <div style={{ marginBottom: 6 }}>
            <div style={{ fontSize: 15, fontWeight: 500, color: "#2C2932" }}>Self-check before you upload</div>
            <div style={{ fontSize: 12.5, fontWeight: 300, color: "#8A857C", marginTop: 2 }}>
              These are exactly the rules the upload validator checks. “Enforced” rules fail the upload; “Recommended” is a warning only.
            </div>
          </div>

          <ul style={{ listStyle: "none", margin: "14px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 12 }}>
            {CHECKLIST.map((c) => {
              const chip = levelChip(c.level);
              return (
                <li
                  key={c.title}
                  style={{
                    display: "flex",
                    gap: 12,
                    padding: "13px 14px",
                    borderRadius: 12,
                    background: "rgba(255,255,255,0.4)",
                    border: "1px solid rgba(60,55,45,0.1)",
                  }}
                >
                  {/* A drawn check mark, not an interactive box — this is a reference
                      list, not a form the presenter fills in. */}
                  <svg width="18" height="18" viewBox="0 0 20 20" fill="none" style={{ flex: "0 0 auto", marginTop: 1 }}>
                    <circle cx="10" cy="10" r="9" fill="rgba(191,224,72,0.3)" />
                    <path d="M6 10.2l2.6 2.6L14 7.2" stroke="#5B7A1E" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 14, fontWeight: 400, color: "#2C2932" }}>{c.title}</span>
                      <span
                        style={{
                          fontSize: 10.5,
                          fontWeight: 500,
                          letterSpacing: "0.03em",
                          padding: "2px 7px",
                          borderRadius: 6,
                          background: chip.bg,
                          color: chip.color,
                        }}
                      >
                        {chip.label}
                      </span>
                    </div>
                    <div style={{ fontSize: 12.5, fontWeight: 300, lineHeight: 1.45, color: "#6E6A62", marginTop: 3 }}>{c.detail}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <style>{`
        .bg-back:hover { background: rgba(255,255,255,0.66) !important; }
        .bg-copy:hover { filter: brightness(1.08); }
      `}</style>
    </div>
  );
}
