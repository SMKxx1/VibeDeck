"use client";

// The Markdown-import modal (with its starter sample) — moved verbatim from
// components/DeckLibrary.tsx.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { noticeStyle } from "./shared";

// The Markdown-import route (/api/admin/decks/import) has its own failure copy —
// its size cap (~400 KB vs the upload path's 2 MB) and slug-conflict wording are
// import-specific — so it gets a sibling of adminErrorMessage rather than reusing
// it. Covers every status the import handler documents.
export function importErrorMessage(status: number, error?: string): string {
  if (error === "empty_markdown") return "Paste some Markdown first.";
  if (status === 413 || error === "payload_too_large") return "That's too large — keep it under ~400 KB.";
  if (error === "invalid_deck") return "Couldn't build a valid deck from that Markdown.";
  if (error === "slug_conflict") return "A deck with that name exists — try a different title.";
  if (status === 401) return "Session expired — sign in again.";
  if (status === 403) return "Blocked for security — reload.";
  if (status === 503 || error === "database_unavailable") return "Database unavailable.";
  return "Couldn't import — try again.";
}

type ImportTheme = "light" | "dark" | "warm";
const IMPORT_THEMES: { key: ImportTheme; label: string }[] = [
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
  { key: "warm", label: "Warm" },
];

// A 2-slide starter dropped into the textarea by "Paste an example" — it shows
// the exact `---` slide separator and that a heading opens each slide, so a
// first-time importer sees the shape of a valid deck at a glance.
const SAMPLE_MARKDOWN = `# Welcome to VibeDeck
Turn plain Markdown into a live deck.

- Write each slide as Markdown
- Separate slides with a line that is only ---
- Import lands the deck hidden, owned by you

---

# How a slide is built
The first heading becomes the slide's title.

Everything under it — text, **bold**, _italic_, and lists — fills the slide. Add as many slides as you like.`;

// The Markdown-import sibling of UploadPanel: same modal chrome, the same
// idle → saving → done state machine, the same close idiom (dismiss routes to
// onClose before a store and onDone after, never mid-save), and the same
// noticeStyle vocabulary. It POSTs Markdown to /api/admin/decks/import; on
// success a hidden deck the importer owns is created (slugs + AI grounding
// derived server-side), then the grid refreshes so its card appears.
export function ImportPanel({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [markdown, setMarkdown] = useState("");
  const [title, setTitle] = useState("");
  const [theme, setTheme] = useState<ImportTheme>("warm");
  // idle → saving → done. "done" holds the panel open on a result view AFTER a
  // successful import so any warnings can show and the presenter can jump to the
  // editor; it no longer auto-closes on success (see submit / dismiss).
  const [status, setStatus] = useState<"idle" | "saving" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  // The 422 invalid_deck issues — shown UNDER the friendly one-liner so the
  // presenter sees both "what went wrong" and "exactly what to fix".
  const [issues, setIssues] = useState<string[]>([]);
  // Non-blocking warnings returned alongside a successful import (201).
  const [warnings, setWarnings] = useState<string[]>([]);
  const [resultSlug, setResultSlug] = useState<string | null>(null);
  const [slideCount, setSlideCount] = useState<number | null>(null);

  // One close path for every dismissal (backdrop, Esc, ✕, Cancel/Done). Never
  // mid-save. Once the deck is stored ("done"), a close MUST refresh the grid so
  // the new card appears — route through onDone; before that a plain onClose.
  const dismiss = useCallback(() => {
    if (status === "saving") return;
    if (status === "done") onDone();
    else onClose();
  }, [status, onClose, onDone]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") dismiss();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismiss]);

  async function submit() {
    setError(null);
    setIssues([]);
    if (!markdown.trim()) {
      setError("Paste some Markdown first.");
      return;
    }
    setStatus("saving");
    try {
      const res = await fetch("/api/admin/decks/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          markdown,
          theme,
          // Only send a title when set — an empty one must trigger the server's
          // heading-derived default, not override it with "".
          ...(title.trim() ? { title: title.trim() } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        slug?: string;
        slideCount?: number;
        warnings?: string[];
        issues?: string[];
        error?: string;
      };
      if (res.ok) {
        // Stored. DON'T close yet — switch to the result view so any warnings
        // show and the presenter can open the editor; they dismiss it (→ refresh).
        setResultSlug(data.slug ?? null);
        setSlideCount(typeof data.slideCount === "number" ? data.slideCount : null);
        setWarnings(Array.isArray(data.warnings) ? data.warnings : []);
        setStatus("done");
        return;
      }
      // Friendly one-liner for every failure; invalid_deck ALSO carries `issues`,
      // so surface that fix-list under the line (see the error notice below).
      setError(importErrorMessage(res.status, data.error));
      if (data.error === "invalid_deck" && Array.isArray(data.issues)) {
        setIssues(data.issues);
      }
      setStatus("idle");
    } catch {
      setError("Network error — try again.");
      setStatus("idle");
    }
  }

  const saving = status === "saving";
  const done = status === "done";
  const label: React.CSSProperties = { fontSize: 11, fontWeight: 500, letterSpacing: "0.1em", textTransform: "uppercase", color: "#9A958A" };
  const field: React.CSSProperties = {
    width: "100%",
    height: 40,
    padding: "0 12px",
    borderRadius: 11,
    border: "1px solid rgba(60,55,45,0.16)",
    background: "rgba(255,255,255,0.7)",
    fontFamily: "inherit",
    fontSize: 14,
    color: "#2C2932",
    outline: "none",
    boxSizing: "border-box",
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Import a deck from Markdown"
      onClick={dismiss}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "rgba(30,28,24,0.34)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(640px, 100%)",
          maxHeight: "calc(100vh - 48px)",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 16,
          padding: 26,
          borderRadius: 22,
          background: "#F4F2EC",
          border: "1px solid rgba(255,255,255,0.8)",
          boxShadow: "0 30px 70px -30px rgba(40,35,25,0.6)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 20, fontWeight: 500, letterSpacing: "-0.01em", color: "#262229" }}>
            {done ? "Deck created" : "Import from Markdown"}
          </div>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Close"
            style={{ width: 32, height: 32, borderRadius: 10, border: "1px solid rgba(60,55,45,0.14)", background: "rgba(255,255,255,0.6)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#6E6A62" strokeWidth={1.5} strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        {done ? (
          // RESULT VIEW — the deck is already stored; confirm it, surface any
          // non-blocking warnings, and offer a jump to the editor. The presenter
          // dismisses via Done / ✕ / Esc / backdrop (all → dismiss → refresh).
          <>
            <div style={noticeStyle("ok")}>
              {slideCount != null ? `Built ${slideCount} ${slideCount === 1 ? "slide" : "slides"}. ` : ""}
              Saved as a hidden deck — set it Public or Live from its card when you’re ready.
            </div>
            {warnings.length > 0 && (
              <div style={noticeStyle("warn")}>
                <div style={{ marginBottom: 4 }}>Imported. Note:</div>
                <ul style={{ margin: 0, paddingLeft: 18, fontWeight: 400 }}>
                  {warnings.map((w, i) => (
                    <li key={i} style={{ marginTop: 2 }}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : (
          <>
            <div style={{ fontSize: 13, lineHeight: 1.5, color: "#6E6A62" }}>
              Paste Markdown to build a deck. It lands hidden and owned by you, with AI context
              derived automatically — publish it from its card when you’re ready.
            </div>

            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={label}>Title (optional)</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Auto from the first heading" style={field} />
            </label>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={label}>Theme</span>
              <div style={{ display: "inline-flex", alignSelf: "flex-start", alignItems: "center", gap: 2, padding: 3, borderRadius: 11, background: "rgba(40,38,32,0.05)", border: "1px solid rgba(60,55,45,0.14)" }}>
                {IMPORT_THEMES.map((opt) => {
                  const active = opt.key === theme;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => setTheme(opt.key)}
                      aria-pressed={active}
                      disabled={saving}
                      style={{
                        height: 30,
                        padding: "0 16px",
                        borderRadius: 8,
                        border: "none",
                        fontFamily: "inherit",
                        fontSize: 13,
                        fontWeight: active ? 600 : 500,
                        cursor: active ? "default" : "pointer",
                        background: active ? "#2C2A31" : "transparent",
                        color: active ? "#F4F2EC" : "#8A857C",
                        transition: "background .15s, color .15s",
                      }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={label}>Markdown</span>
                <button
                  type="button"
                  onClick={() => setMarkdown(SAMPLE_MARKDOWN)}
                  style={{ fontFamily: "inherit", fontSize: 11.5, fontWeight: 500, color: "#4A4750", background: "rgba(255,255,255,0.7)", border: "1px solid rgba(60,55,45,0.14)", borderRadius: 8, padding: "4px 9px", cursor: "pointer" }}
                >
                  Paste an example
                </button>
              </div>
              <textarea
                value={markdown}
                onChange={(e) => setMarkdown(e.target.value)}
                placeholder={"# Slide one\n\nYour first slide…\n\n---\n\n# Slide two\n\nYour second slide…"}
                spellCheck={false}
                autoFocus
                style={{ ...field, height: 240, padding: 12, resize: "vertical", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12.5, lineHeight: 1.5 }}
              />
              <span style={{ fontSize: 12, color: "#8A857C" }}>Separate slides with a line containing only ---</span>
            </label>

            {/* One error box: the friendly one-liner leads, and when the server
                returned invalid_deck issues, the fix-list follows beneath it. */}
            {(error || issues.length > 0) && (
              <div style={noticeStyle("error")}>
                {error && <div style={{ marginBottom: issues.length > 0 ? 4 : 0 }}>{error}</div>}
                {issues.length > 0 && (
                  <ul style={{ margin: 0, paddingLeft: 18, fontWeight: 400 }}>
                    {issues.map((it, i) => (
                      <li key={i} style={{ marginTop: 2 }}>{it}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 2 }}>
          {done ? (
            <>
              {resultSlug && (
                <Link
                  href={`/dashboard/edit/${resultSlug}`}
                  style={{ display: "inline-flex", alignItems: "center", fontFamily: "inherit", fontSize: 14, fontWeight: 400, color: "#4A4750", background: "transparent", border: "1px solid rgba(60,55,45,0.18)", borderRadius: 11, padding: "0 18px", height: 42, textDecoration: "none" }}
                >
                  Open in editor
                </Link>
              )}
              <button
                type="button"
                className="lm-panel-btn"
                onClick={onDone}
                style={{ fontFamily: "inherit", fontSize: 14, fontWeight: 500, color: "#F4F2EC", background: "#2C2A31", border: "none", borderRadius: 11, padding: "0 22px", height: 42, cursor: "pointer" }}
              >
                Done
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={dismiss}
                disabled={saving}
                style={{ fontFamily: "inherit", fontSize: 14, fontWeight: 400, color: "#4A4750", background: "transparent", border: "1px solid rgba(60,55,45,0.18)", borderRadius: 11, padding: "0 18px", height: 42, cursor: saving ? "default" : "pointer" }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="lm-panel-btn"
                onClick={submit}
                disabled={saving}
                style={{ fontFamily: "inherit", fontSize: 14, fontWeight: 500, color: "#F4F2EC", background: "#2C2A31", border: "none", borderRadius: 11, padding: "0 22px", height: 42, cursor: saving ? "default" : "pointer", opacity: saving ? 0.75 : 1 }}
              >
                {saving ? "Creating…" : "Create deck"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
