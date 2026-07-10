"use client";

// Presenter-only editor for a deck's per-slide SPEAKER NOTES and AI CONTEXT
// (the chatbot's grounding). Styled to the warm "Solis" palette to match the
// dashboard it's launched from. Each slide is a card with two textareas and a
// per-card Save button (idle / dirty / saving / saved / error). Saving PUTs to
// /api/admin/slides; the label is read-only. When the DB is unavailable the
// whole editor shows a banner and disables saving.
//
// One-Click AI Grounding (feature #8): each card has a "Generate with AI" button
// and the header has a "Generate all empty" convenience. Both call
// POST /api/admin/slides/generate, which returns a SUGGESTION and never saves.
// Generation only FILLS the editable fields — the presenter reviews/edits and
// then persists with the existing per-card Save. This is the hard rule: a
// generated draft is never auto-saved.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

export interface EditorSlide {
  index: number;
  label: string;
  speakerNotes: string;
  aiContext: string;
}

const MAX_FIELD = 8000;

// Imperative handle each SlideCard registers with the parent so the deck-level
// "Generate all empty" can (a) read whether a slide's AI context is currently
// empty and (b) trigger that slide's own generate-and-fill — without lifting all
// per-card edit state up to the parent. generate() resolves to "ok"/"error" so
// the bulk loop can count fills and skip failures.
type SlideHandle = {
  isAiContextEmpty: () => boolean;
  generate: () => Promise<"ok" | "error">;
};

type BulkStatus = "idle" | "running" | "done" | "cancelled" | "empty";

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
  // Registry of live per-card handles, keyed by slide index. A card registers a
  // STABLE handle on mount whose methods read the latest values via refs, so the
  // parent always sees current state without re-registering on every keystroke.
  const handlesRef = useRef<Map<number, SlideHandle>>(new Map());
  const register = useCallback((index: number, handle: SlideHandle) => {
    handlesRef.current.set(index, handle);
    return () => {
      if (handlesRef.current.get(index) === handle) handlesRef.current.delete(index);
    };
  }, []);

  const [bulkStatus, setBulkStatus] = useState<BulkStatus>("idle");
  const [bulkTotal, setBulkTotal] = useState(0);
  const [bulkDone, setBulkDone] = useState(0);
  const [bulkSkipped, setBulkSkipped] = useState(0);
  const cancelRef = useRef(false);
  const running = bulkStatus === "running";

  // Generate-all-empty: snapshot the slides whose AI context is currently empty
  // (so authored grounding is never clobbered), then generate them ONE AT A TIME
  // — awaiting each with a small gap so we never fan 20 requests at the per-user
  // rate limit at once. Fills each card's fields for review; never saves. A
  // failed slide is skipped and the loop continues; Cancel stops it.
  const generateAllEmpty = useCallback(async () => {
    if (!dbAvailable || running) return;
    const targets: number[] = [];
    for (const s of slides) {
      const h = handlesRef.current.get(s.index);
      if (h && h.isAiContextEmpty()) targets.push(s.index);
    }
    if (targets.length === 0) {
      setBulkStatus("empty");
      return;
    }
    cancelRef.current = false;
    setBulkTotal(targets.length);
    setBulkDone(0);
    setBulkSkipped(0);
    setBulkStatus("running");

    let done = 0;
    let skipped = 0;
    for (const idx of targets) {
      if (cancelRef.current) break;
      const h = handlesRef.current.get(idx);
      if (!h) {
        done += 1;
        skipped += 1;
        setBulkDone(done);
        setBulkSkipped(skipped);
        continue;
      }
      const result = await h.generate();
      done += 1;
      if (result === "error") skipped += 1;
      setBulkDone(done);
      setBulkSkipped(skipped);
      if (cancelRef.current) break;
      if (done < targets.length) {
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    setBulkStatus(cancelRef.current ? "cancelled" : "done");
  }, [dbAvailable, running, slides]);

  const bulkBtnDisabled = !dbAvailable || running;

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

        {slides.length > 0 && (
          <div style={{ marginBottom: 22 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={generateAllEmpty}
                disabled={bulkBtnDisabled}
                title="Fill every slide that has no AI context yet — drafts fill the fields for review; nothing is saved."
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  height: 38,
                  padding: "0 18px",
                  borderRadius: 11,
                  border: "none",
                  cursor: bulkBtnDisabled ? "default" : "pointer",
                  background: bulkBtnDisabled ? "#D9DEC4" : "#BFE048",
                  color: bulkBtnDisabled ? "#8A857C" : "#2C2A31",
                  fontFamily: "inherit",
                  fontSize: 14,
                  fontWeight: 500,
                }}
              >
                <SparkleIcon size={15} color={bulkBtnDisabled ? "#A29D92" : "#2C2A31"} />
                {running ? "Generating…" : "Generate all empty"}
              </button>

              {running && (
                <>
                  <span style={{ fontSize: 13.5, color: "#6E6A62" }}>
                    Generating {Math.min(bulkDone + 1, bulkTotal)} / {bulkTotal}…
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      cancelRef.current = true;
                    }}
                    style={{
                      height: 32,
                      padding: "0 14px",
                      borderRadius: 10,
                      border: "1px solid rgba(60,55,45,0.22)",
                      background: "transparent",
                      color: "#6E6A62",
                      fontFamily: "inherit",
                      fontSize: 13,
                      fontWeight: 500,
                      cursor: "pointer",
                    }}
                  >
                    Cancel
                  </button>
                </>
              )}

              {bulkStatus === "done" && (
                <span style={{ fontSize: 13.5, color: "#4F7A2E" }}>
                  Filled {bulkTotal - bulkSkipped} slide{bulkTotal - bulkSkipped === 1 ? "" : "s"}
                  {bulkSkipped > 0 ? `, skipped ${bulkSkipped}` : ""} — review &amp; Save each.
                </span>
              )}
              {bulkStatus === "cancelled" && (
                <span style={{ fontSize: 13.5, color: "#B08900" }}>
                  Cancelled — filled {bulkDone - bulkSkipped} slide
                  {bulkDone - bulkSkipped === 1 ? "" : "s"}
                  {bulkSkipped > 0 ? `, skipped ${bulkSkipped}` : ""}.
                </span>
              )}
              {bulkStatus === "empty" && (
                <span style={{ fontSize: 13.5, color: "#6E6A62" }}>
                  Every slide already has AI context — nothing to generate.
                </span>
              )}
            </div>
            <p style={{ margin: "10px 0 0", fontSize: 12.5, color: "#8A857C", lineHeight: 1.5 }}>
              AI drafts grounding from each slide&apos;s own content and fills the fields below for
              review — nothing is saved until you press Save on that slide.
            </p>
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
              <SlideCard
                key={s.index}
                slug={slug}
                slide={s}
                dbAvailable={dbAvailable}
                register={register}
                bulkRunning={running}
              />
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
type GenStatus = "idle" | "generating" | "error";

function SlideCard({
  slug,
  slide,
  dbAvailable,
  register,
  bulkRunning,
}: {
  slug: string;
  slide: EditorSlide;
  dbAvailable: boolean;
  register: (index: number, handle: SlideHandle) => () => void;
  bulkRunning: boolean;
}) {
  const [notes, setNotes] = useState(slide.speakerNotes);
  const [ctx, setCtx] = useState(slide.aiContext);
  const [savedNotes, setSavedNotes] = useState(slide.speakerNotes);
  const [savedCtx, setSavedCtx] = useState(slide.aiContext);
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [genStatus, setGenStatus] = useState<GenStatus>("idle");
  const [genError, setGenError] = useState<string | null>(null);

  // Keep the latest AI-context value reachable from the (stable) imperative
  // handle so the deck-level bulk run can test emptiness without re-registering.
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const dirty = notes !== savedNotes || ctx !== savedCtx;
  const tooLong = notes.length > MAX_FIELD || ctx.length > MAX_FIELD;
  const canSave = dbAvailable && dirty && !tooLong && status !== "saving";

  // Generate a suggestion and FILL the editable fields. Review-before-save: the
  // server returns a draft and never persists — the existing Save button does.
  // Overwrites BOTH fields (it's an explicit action). Kept stable (only setters
  // + props) so the imperative handle never goes stale.
  const generate = useCallback(async (): Promise<"ok" | "error"> => {
    setGenStatus("generating");
    setGenError(null);
    try {
      const res = await fetch("/api/admin/slides/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, index: slide.index }),
      });
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          aiContext?: string;
          speakerNotes?: string;
        };
        // Fill for review — these now differ from the saved values, so the card
        // flips to "Unsaved changes" and the existing Save button lights up.
        setCtx(data.aiContext ?? "");
        setNotes(data.speakerNotes ?? "");
        setGenStatus("idle");
        return "ok";
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setGenStatus("error");
      setGenError(generateMessageFor(res.status, data.error));
      return "error";
    } catch {
      setGenStatus("error");
      setGenError("Couldn't generate — try again.");
      return "error";
    }
  }, [slug, slide.index]);

  const isAiContextEmpty = useCallback(() => ctxRef.current.trim().length === 0, []);

  useEffect(
    () => register(slide.index, { isAiContextEmpty, generate }),
    [register, slide.index, isAiContextEmpty, generate],
  );

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

  const genBusy = genStatus === "generating";
  const genDisabled = !dbAvailable || genBusy || bulkRunning;

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
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flex: 1, minWidth: 0 }}>
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

        <button
          type="button"
          onClick={generate}
          disabled={genDisabled}
          title="Draft this slide's notes & AI context from its content — fills the fields for review (replaces any current text). Save persists it."
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            height: 32,
            padding: "0 13px",
            borderRadius: 10,
            border: "1px solid rgba(60,55,45,0.16)",
            cursor: genDisabled ? "default" : "pointer",
            background: genDisabled ? "rgba(60,55,45,0.05)" : "rgba(191,224,72,0.22)",
            color: genDisabled ? "#A29D92" : "#4C4A38",
            fontFamily: "inherit",
            fontSize: 13,
            fontWeight: 500,
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          <SparkleIcon size={14} color={genDisabled ? "#B9B5AD" : "#6C7A1F"} />
          {genBusy ? "Generating…" : "Generate with AI"}
        </button>
      </div>

      {genStatus === "error" && genError && (
        <div
          style={{
            marginBottom: 14,
            padding: "8px 12px",
            borderRadius: 10,
            background: "rgba(194,59,39,0.07)",
            border: "1px solid rgba(194,59,39,0.22)",
            color: "#8F2C1D",
            fontSize: 13,
            lineHeight: 1.45,
          }}
        >
          {genError}
        </div>
      )}

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

// A tasteful two-point sparkle to mark the AI-generate affordances, matching the
// file's minimal SVG-icon style. Purely decorative.
function SparkleIcon({ size = 15, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M10 2 Q10 9 17 9 Q10 9 10 16 Q10 9 3 9 Q10 9 10 2 Z" fill={color} />
      <path
        d="M18 13 Q18 16.5 21.5 16.5 Q18 16.5 18 20 Q18 16.5 14.5 16.5 Q18 16.5 18 13 Z"
        fill={color}
        opacity={0.75}
      />
    </svg>
  );
}

function messageFor(status: number, error?: string): string {
  if (status === 401) return "Session expired — sign in again.";
  if (status === 503) return "Database unavailable — try again later.";
  if (error === "too_long") return `Keep each field under ${MAX_FIELD.toLocaleString()} characters.`;
  return "Couldn't save — try again.";
}

// Friendly copy for the /api/admin/slides/generate failure codes. Error code
// takes priority over status (the route pairs codes with 400/429/502/503 etc);
// 401/403 fall through to status.
function generateMessageFor(status: number, error?: string): string {
  if (error === "ai_budget_exceeded") return "AI is at today's usage limit — try again later.";
  if (error === "rate_limited") return "Too many requests — wait a moment and retry.";
  if (error === "ai_not_configured") return "AI isn't configured on the server.";
  if (error === "not_uploaded") return "AI grounding is only available for uploaded decks.";
  if (error === "not_found") return "Slide not found — reload and retry.";
  if (status === 401) return "Session expired — sign in again.";
  if (status === 403) return "Blocked for security — reload.";
  return "Couldn't generate — try again.";
}
