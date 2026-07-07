"use client";

// Presenter-only editor for a deck's per-slide SPEAKER NOTES and AI CONTEXT
// (the chatbot's grounding). Styled to the warm "Solis" palette to match the
// dashboard it's launched from. Each slide is a card with two textareas and a
// per-card Save button (idle / dirty / saving / saved / error). Saving PUTs to
// /api/admin/slides; the label is read-only. When the DB is unavailable the
// whole editor shows a banner and disables saving.

import { useState } from "react";
import Link from "next/link";

export interface EditorSlide {
  index: number;
  label: string;
  speakerNotes: string;
  aiContext: string;
}

const MAX_FIELD = 8000;

export function SlideMetaEditor({
  slug,
  deckTitle,
  slides,
  dbAvailable,
}: {
  slug: string;
  deckTitle: string;
  slides: EditorSlide[];
  dbAvailable: boolean;
}) {
  return (
    <div
      style={{
        minHeight: "100vh",
        padding: "34px 24px 60px",
        display: "flex",
        justifyContent: "center",
        background: "#ECEAE3",
        backgroundImage: "radial-gradient(rgba(40,38,32,0.045) 1px, transparent 1.4px)",
        backgroundSize: "22px 22px",
      }}
    >
      <div style={{ width: "100%", maxWidth: 860 }}>
        {/* header */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 24 }}>
          <Link
            href="/dashboard"
            style={{ fontSize: 13.5, color: "#8A857C", textDecoration: "none", width: "fit-content" }}
          >
            ← Back to dashboard
          </Link>
          <div>
            <div
              style={{
                fontSize: 12,
                fontWeight: 500,
                letterSpacing: "0.2em",
                textTransform: "uppercase",
                color: "#9A958A",
                marginBottom: 8,
              }}
            >
              Edit notes &amp; AI context
            </div>
            <h1
              style={{
                fontSize: 30,
                fontWeight: 300,
                lineHeight: 1.1,
                letterSpacing: "-0.02em",
                margin: 0,
                color: "#262229",
              }}
            >
              {deckTitle}
            </h1>
          </div>
        </div>

        {!dbAvailable && (
          <div
            style={{
              marginBottom: 20,
              padding: "14px 18px",
              borderRadius: 14,
              background: "rgba(194,59,39,0.08)",
              border: "1px solid rgba(194,59,39,0.28)",
              color: "#8F2C1D",
              fontSize: 14,
              lineHeight: 1.5,
            }}
          >
            <strong style={{ fontWeight: 600 }}>Database unavailable — editing disabled.</strong>{" "}
            The chatbot is grounding on the built-in static slide context and the presenter console
            is showing the embed deck&apos;s own notes. Set <code>DATABASE_URL</code> to enable
            editing.
          </div>
        )}

        {slides.length === 0 ? (
          <div style={{ color: "#6E6A62", fontSize: 15 }}>
            {dbAvailable
              ? "This deck has no editable slides."
              : "No slide data to show while the database is unavailable."}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {slides.map((s) => (
              <SlideCard key={s.index} slug={slug} slide={s} dbAvailable={dbAvailable} />
            ))}
          </div>
        )}
      </div>

      <style>{`
        .sme-textarea:focus { border-color: rgba(60,55,45,0.4) !important; }
      `}</style>
    </div>
  );
}

type Status = "idle" | "saving" | "saved" | "error";

function SlideCard({
  slug,
  slide,
  dbAvailable,
}: {
  slug: string;
  slide: EditorSlide;
  dbAvailable: boolean;
}) {
  const [notes, setNotes] = useState(slide.speakerNotes);
  const [ctx, setCtx] = useState(slide.aiContext);
  const [savedNotes, setSavedNotes] = useState(slide.speakerNotes);
  const [savedCtx, setSavedCtx] = useState(slide.aiContext);
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const dirty = notes !== savedNotes || ctx !== savedCtx;
  const tooLong = notes.length > MAX_FIELD || ctx.length > MAX_FIELD;
  const canSave = dbAvailable && dirty && !tooLong && status !== "saving";

  async function save() {
    if (!canSave) return;
    setStatus("saving");
    setErrorMsg(null);
    try {
      const res = await fetch("/api/admin/slides", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, index: slide.index, speakerNotes: notes, aiContext: ctx }),
      });
      if (res.ok) {
        setSavedNotes(notes);
        setSavedCtx(ctx);
        setStatus("saved");
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setStatus("error");
        setErrorMsg(messageFor(res.status, data.error));
      }
    } catch {
      setStatus("error");
      setErrorMsg("Network error — try again.");
    }
  }

  return (
    <section
      style={{
        padding: "20px 22px 22px",
        borderRadius: 18,
        background: "rgba(255,255,255,0.55)",
        border: "1px solid rgba(255,255,255,0.75)",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        boxShadow: "0 10px 28px -18px rgba(60,55,45,0.4)",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 16 }}>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: "0.08em",
            color: "#5E5A52",
            background: "rgba(191,224,72,0.35)",
            padding: "3px 9px",
            borderRadius: 8,
            whiteSpace: "nowrap",
          }}
        >
          Slide {slide.index + 1}
        </span>
        <span style={{ fontSize: 15, fontWeight: 400, color: "#2C2932", lineHeight: 1.3 }}>
          {slide.label || <em style={{ color: "#9A958A" }}>Untitled slide</em>}
        </span>
      </div>

      <Field
        label="Speaker notes"
        value={notes}
        onChange={setNotes}
        disabled={!dbAvailable}
        rows={3}
      />
      <div style={{ height: 14 }} />
      <Field
        label="AI context (chatbot grounding)"
        value={ctx}
        onChange={setCtx}
        disabled={!dbAvailable}
        rows={6}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 16 }}>
        <button
          type="button"
          onClick={save}
          disabled={!canSave}
          style={{
            height: 38,
            padding: "0 20px",
            borderRadius: 11,
            border: "none",
            cursor: canSave ? "pointer" : "default",
            background: canSave ? "#2C2A31" : "#B9B5AD",
            color: "#F4F2EC",
            fontFamily: "inherit",
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          {status === "saving" ? "Saving…" : "Save"}
        </button>

        <StatusPill dirty={dirty} status={status} errorMsg={errorMsg} tooLong={tooLong} />
      </div>
    </section>
  );
}

function StatusPill({
  dirty,
  status,
  errorMsg,
  tooLong,
}: {
  dirty: boolean;
  status: Status;
  errorMsg: string | null;
  tooLong: boolean;
}) {
  if (tooLong) {
    return <span style={{ fontSize: 13, color: "#C23B27" }}>Too long — keep each field under {MAX_FIELD.toLocaleString()} characters.</span>;
  }
  if (status === "saving") {
    return <span style={{ fontSize: 13, color: "#8A857C" }}>Saving…</span>;
  }
  // `dirty` is checked before both the "error" and "saved" terminal states so
  // that editing the text after a failed (or successful) save flips the pill
  // back to "Unsaved changes" instead of leaving a stale message on screen.
  if (dirty) {
    return <span style={{ fontSize: 13, color: "#B08900" }}>Unsaved changes</span>;
  }
  if (status === "error") {
    return <span style={{ fontSize: 13, color: "#C23B27" }}>{errorMsg ?? "Couldn't save."}</span>;
  }
  if (status === "saved") {
    return <span style={{ fontSize: 13, color: "#4F7A2E" }}>Saved ✓</span>;
  }
  return null;
}

function Field({
  label,
  value,
  onChange,
  disabled,
  rows,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  rows: number;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      <span
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          fontSize: 12,
          fontWeight: 500,
          letterSpacing: "0.02em",
          color: "#6E6A62",
        }}
      >
        {label}
        <span style={{ fontSize: 11, color: value.length > MAX_FIELD ? "#C23B27" : "#A29D92" }}>
          {value.length.toLocaleString()} / {MAX_FIELD.toLocaleString()}
        </span>
      </span>
      <textarea
        className="sme-textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        rows={rows}
        style={{
          width: "100%",
          resize: "vertical",
          padding: "11px 13px",
          borderRadius: 12,
          border: "1px solid rgba(60,55,45,0.18)",
          background: disabled ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.72)",
          fontFamily: "inherit",
          fontSize: 14,
          lineHeight: 1.55,
          color: "#2C2A31",
          outline: "none",
          boxSizing: "border-box",
        }}
      />
    </label>
  );
}

function messageFor(status: number, error?: string): string {
  if (status === 401) return "Session expired — sign in again.";
  if (status === 503) return "Database unavailable — try again later.";
  if (error === "too_long") return `Keep each field under ${MAX_FIELD.toLocaleString()} characters.`;
  return "Couldn't save — try again.";
}
