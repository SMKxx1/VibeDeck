"use client";

// The upload / replace modal — moved verbatim from components/DeckLibrary.tsx.

import { useCallback, useEffect, useRef, useState } from "react";
import { BootCheck } from "./BootCheck";
import { adminErrorMessage, noticeStyle, type PanelState } from "./shared";

// The shared modal for both creating and replacing an uploaded deck. Reuses the
// same idle/saving/error state machine idiom as PublishControl.setStatus — one
// in-flight guard, an error line on failure, and a parent-driven close on
// success (onDone → refresh). A textarea for pasting HTML is the MVP input; the
// file picker is a convenience that just reads a chosen .html file INTO the same
// textarea (so the submit path is identical whether pasted or picked).
export function UploadPanel({ panel, onClose, onDone }: { panel: PanelState; onClose: () => void; onDone: () => void }) {
  const replacing = panel.mode === "replace";
  const existing = replacing ? panel.deck : undefined;
  const [title, setTitle] = useState(existing?.title ?? "");
  const [slug, setSlug] = useState("");
  const [date, setDate] = useState("");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [html, setHtml] = useState("");
  // idle → saving → done. "done" holds the panel open on a result view AFTER a
  // successful store so the boot check can run and warnings can show; the panel
  // no longer auto-closes on success (see submit / dismiss).
  const [status, setStatus] = useState<"idle" | "saving" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  // The validator's 422 invalid_deck issues — the "here's exactly what to fix"
  // list, the primary Phase-2 feedback loop. Kept apart from `error` (a one-line
  // generic failure) so each renders with the right shape.
  const [issues, setIssues] = useState<string[]>([]);
  // Non-blocking warnings returned alongside a SUCCESSFUL store (201/200).
  const [warnings, setWarnings] = useState<string[]>([]);
  // The slug the store actually landed on — POST auto-derives it from the title,
  // so we read it back from the response to point the boot check at the right deck.
  const [resultSlug, setResultSlug] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // One close path for every dismissal (backdrop, Esc, ✕, Cancel/Done). Never
  // mid-save. Once the deck is stored ("done"), a close MUST refresh the grid so
  // the new/updated card appears — route through onDone; before that a plain
  // onClose (nothing changed server-side yet, so no refresh needed).
  const dismiss = useCallback(() => {
    if (status === "saving") return;
    if (status === "done") onDone();
    else onClose();
  }, [status, onClose, onDone]);

  // Esc closes, matching the backdrop click — but never mid-save (a close would
  // strand an in-flight request the presenter can't see the result of).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") dismiss();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismiss]);

  function pickFile(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setHtml(typeof reader.result === "string" ? reader.result : "");
      // Seed the title from the filename only when the presenter hasn't typed one.
      setTitle((t) => t || file.name.replace(/\.html?$/i, ""));
    };
    reader.readAsText(file);
  }

  async function submit() {
    setError(null);
    setIssues([]);
    if (!title.trim() || !html.trim()) {
      setError("Title and HTML are both required.");
      return;
    }
    setStatus("saving");
    try {
      const res = replacing
        ? await fetch(`/api/admin/decks/${existing!.slug}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: title.trim(), html }),
          })
        : await fetch("/api/admin/decks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: title.trim(),
              html,
              // Only send optional fields when set — an empty slug must trigger
              // the server's title-derived auto-slug, not fail slug validation.
              ...(slug.trim() ? { slug: slug.trim() } : {}),
              ...(date.trim() ? { date: date.trim() } : {}),
              ...(description.trim() ? { description: description.trim() } : {}),
            }),
          });
      // POST(201) and PUT(200) both return { slug, warnings }; both reject non-
      // conformance with 422 { error:"invalid_deck", issues, warnings }. Parse
      // once and branch on ok so the create/replace paths share this handler.
      const data = (await res.json().catch(() => ({}))) as {
        slug?: string;
        warnings?: string[];
        issues?: string[];
        error?: string;
      };
      if (res.ok) {
        // Stored. DON'T close yet — switch to the result view so the boot check
        // can run and any warnings show; the presenter dismisses it (→ refresh).
        setResultSlug(data.slug ?? (replacing ? existing!.slug : null));
        setWarnings(Array.isArray(data.warnings) ? data.warnings : []);
        setStatus("done");
        return;
      }
      // 422 invalid_deck is the Phase-2 contract's primary feedback: surface the
      // structural issues verbatim (leading over the generic line) so the
      // presenter knows exactly what to fix, then drop back to idle to retry.
      if (res.status === 422 && Array.isArray(data.issues) && data.issues.length > 0) {
        setIssues(data.issues);
      } else {
        setError(adminErrorMessage(res.status, data.error));
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
      aria-label={replacing ? "Replace deck" : "Upload a new deck"}
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
            {done ? (replacing ? "Deck replaced" : "Deck uploaded") : replacing ? "Replace deck content" : "Upload a deck"}
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
          // non-blocking warnings, and run the live boot check. The presenter
          // dismisses via Done / ✕ / Esc / backdrop (all → dismiss → refresh).
          <>
            <div style={noticeStyle("ok")}>
              {replacing
                ? "Content replaced — the deck's link and publish status are unchanged."
                : "Saved as a hidden deck — set it Public or Live from its card when you're ready."}
            </div>
            {warnings.length > 0 && (
              <div style={noticeStyle("warn")}>
                <div style={{ marginBottom: 4 }}>{replacing ? "Replaced. Note:" : "Uploaded. Note:"}</div>
                <ul style={{ margin: 0, paddingLeft: 18, fontWeight: 400 }}>
                  {warnings.map((w, i) => (
                    <li key={i} style={{ marginTop: 2 }}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
            {resultSlug && <BootCheck slug={resultSlug} />}
          </>
        ) : (
          <>
            {replacing && (
              <div style={{ fontSize: 13, lineHeight: 1.5, color: "#6E6A62" }}>
                Replacing <strong style={{ color: "#2C2932" }}>{existing!.title}</strong> swaps its HTML only — its
                publish status and link (<code>/d/{existing!.slug}</code>) stay exactly as they are.
              </div>
            )}

            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={label}>Title</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Deck title" style={field} autoFocus />
            </label>

            {!replacing && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={label}>Slug (optional)</span>
                  <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="auto from title" style={field} />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={label}>Date (optional)</span>
                  <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={field} />
                </label>
              </div>
            )}

            {!replacing && (
              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={label}>Description (optional)</span>
                <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="One-line summary" style={field} />
              </label>
            )}

            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={label}>HTML{replacing ? " (new content)" : ""}</span>
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  style={{ fontFamily: "inherit", fontSize: 11.5, fontWeight: 500, color: "#4A4750", background: "rgba(255,255,255,0.7)", border: "1px solid rgba(60,55,45,0.14)", borderRadius: 8, padding: "4px 9px", cursor: "pointer" }}
                >
                  Choose .html file
                </button>
                <input ref={fileRef} type="file" accept=".html,.htm,text/html" onChange={(e) => pickFile(e.target.files?.[0])} style={{ display: "none" }} />
              </div>
              <textarea
                value={html}
                onChange={(e) => setHtml(e.target.value)}
                placeholder="<!doctype html> … paste a self-contained HTML deck"
                spellCheck={false}
                style={{ ...field, height: 200, padding: 12, resize: "vertical", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12.5, lineHeight: 1.5 }}
              />
            </label>

            {/* The validator's structural rejection (422) — the primary Phase-2
                feedback loop. Lead with the exact fix list; the generic one-liner
                below only shows for the OTHER failure modes (auth/slug/size/…). */}
            {issues.length > 0 && (
              <div style={noticeStyle("error")}>
                <div style={{ marginBottom: 4 }}>This deck can’t be used yet:</div>
                <ul style={{ margin: 0, paddingLeft: 18, fontWeight: 400 }}>
                  {issues.map((it, i) => (
                    <li key={i} style={{ marginTop: 2 }}>{it}</li>
                  ))}
                </ul>
              </div>
            )}

            {error && <div style={noticeStyle("error")}>{error}</div>}
          </>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 2 }}>
          {done ? (
            // The store already succeeded; the only action left is to leave —
            // which refreshes the grid so the new/updated card shows (via onDone).
            <button
              type="button"
              className="lm-panel-btn"
              onClick={onDone}
              style={{ fontFamily: "inherit", fontSize: 14, fontWeight: 500, color: "#F4F2EC", background: "#2C2A31", border: "none", borderRadius: 11, padding: "0 22px", height: 42, cursor: "pointer" }}
            >
              Done
            </button>
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
                {saving ? "Saving…" : replacing ? "Replace content" : "Upload deck"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
