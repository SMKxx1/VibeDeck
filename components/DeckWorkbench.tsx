"use client";

// VDML Workbench: in-app HTML editor + sandboxed live preview for an UPLOADED
// deck. Rendered ONLY for kind==='uploaded' (the edit page gates this). Fixing a
// typo no longer means export → edit → re-upload: the owner edits the deck's
// HTML in CodeMirror, Save persists a DRAFT (decks.draft_html — the live deck is
// untouched), the preview iframe renders the draft through the REAL deck origin
// (/d-content/<slug>?draft=1&t=<token> — same strict CSP, same forced sandbox,
// same injected runtime as the live serve path), and Publish validates +
// atomically swaps the draft into the live bytes.
//
// SECURITY (the whole story, none of it new):
//  • The preview frames the isolated DECK_ORIGIN with sandbox="allow-scripts"
//    ONLY — NEVER allow-same-origin — so the draft runs in an opaque origin with
//    no cookies/storage, exactly like every other uploaded-deck frame
//    (UploadedDeckFrame / SlideMetaEditor's DeckPreview).
//  • The draft URL is a short-lived SIGNED capability minted by the owner-gated
//    /api/admin/decks/[slug]/draft route; without it /d-content?draft=1 is a
//    bare 404. Tokens expire (~5 min) — a stale frame just 404s and the
//    presenter hits "Refresh preview" for a fresh one.
//  • CodeMirror is SELF-HOSTED (bundled npm packages, no CDN) so the app's own
//    CSP story and offline behavior are unchanged.
//
// SOLO editor by design — no CRDT, last save wins. Drafts are deliberately
// UNVALIDATED on save (mid-edit HTML may be broken); validation gates Publish,
// which returns the validator's issues for inline display on 422.

import { useCallback, useEffect, useRef, useState } from "react";
import { basicSetup } from "codemirror";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { html as htmlLang } from "@codemirror/lang-html";
import { oneDark } from "@codemirror/theme-one-dark";

type Phase = "loading" | "ready" | "load_error";
type Busy = "idle" | "saving" | "publishing" | "discarding" | "refreshing";

interface DraftGetResponse {
  html?: string;
  hasDraft?: boolean;
  slideCount?: number;
  previewUrl?: string | null;
}

interface StatusNote {
  kind: "ok" | "warn" | "error";
  text: string;
}

const MAX_BYTES = 2_000_000; // mirror the route's cap for a friendly pre-flight message

export function DeckWorkbench({ slug }: { slug: string }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [busy, setBusy] = useState<Busy>("idle");
  const [hasDraft, setHasDraft] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [note, setNote] = useState<StatusNote | null>(null);
  // Publish-validation failures, rendered inline under the buttons.
  const [issues, setIssues] = useState<string[]>([]);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // The initial document, held until the editor mounts (fetch completes first).
  const initialDocRef = useRef<string>("");

  // ── load the working copy ─────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/admin/decks/${slug}/draft`, { signal: ctrl.signal });
        const data = (await res.json().catch(() => ({}))) as DraftGetResponse;
        if (!alive) return;
        if (!res.ok || typeof data.html !== "string") {
          setPhase("load_error");
          return;
        }
        initialDocRef.current = data.html;
        setHasDraft(!!data.hasDraft);
        setPreviewUrl(data.previewUrl ?? null);
        setPhase("ready");
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (alive) setPhase("load_error");
      }
    })();
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [slug]);

  // ── mount CodeMirror once the content is in hand ──────────────────────────
  useEffect(() => {
    if (phase !== "ready" || !hostRef.current || viewRef.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: initialDocRef.current,
        extensions: [
          basicSetup,
          htmlLang(),
          oneDark,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) setDirty(true);
          }),
          EditorView.theme({
            "&": { height: "100%", fontSize: "13px" },
            ".cm-scroller": { overflow: "auto" },
          }),
        ],
      }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [phase]);

  const getDoc = useCallback(() => viewRef.current?.state.doc.toString() ?? "", []);

  const setDoc = useCallback((next: string) => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
  }, []);

  // ── actions ───────────────────────────────────────────────────────────────

  // Save the current buffer as the draft. Returns true on success so Publish can
  // chain. A fresh previewUrl (new token) reloads the iframe with the new bytes.
  const saveDraft = useCallback(async (): Promise<boolean> => {
    const doc = getDoc();
    if (new TextEncoder().encode(doc).length > MAX_BYTES) {
      setNote({ kind: "error", text: "Too large — a deck must stay under 2 MB." });
      return false;
    }
    try {
      const res = await fetch(`/api/admin/decks/${slug}/draft`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html: doc }),
      });
      if (!res.ok) {
        setNote({ kind: "error", text: errorMessageFor(res.status) });
        return false;
      }
      const data = (await res.json().catch(() => ({}))) as DraftGetResponse;
      setHasDraft(true);
      setDirty(false);
      setPreviewUrl(data.previewUrl ?? null);
      return true;
    } catch {
      setNote({ kind: "error", text: "Network error — try again." });
      return false;
    }
  }, [slug, getDoc]);

  const onSave = useCallback(async () => {
    if (busy !== "idle") return;
    setBusy("saving");
    setNote(null);
    setIssues([]);
    const ok = await saveDraft();
    if (ok) setNote({ kind: "ok", text: "Draft saved — preview reloaded." });
    setBusy("idle");
  }, [busy, saveDraft]);

  // Publish = make the buffer the LIVE bytes: save it as the draft first (so what
  // publishes is exactly what's on screen), then ask the server to validate +
  // atomically swap. A 422 renders the validator's issues inline.
  const onPublish = useCallback(async () => {
    if (busy !== "idle") return;
    setBusy("publishing");
    setNote(null);
    setIssues([]);
    const saved = await saveDraft();
    if (!saved) {
      setBusy("idle");
      return;
    }
    try {
      const res = await fetch(`/api/admin/decks/${slug}/draft`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        issues?: string[];
        warnings?: string[];
      };
      if (res.status === 422) {
        setIssues(data.issues ?? []);
        setNote({ kind: "error", text: "Not published — fix the issues below and try again." });
      } else if (!res.ok) {
        setNote({ kind: "error", text: errorMessageFor(res.status) });
      } else {
        setHasDraft(false);
        const warned = (data.warnings ?? []).length > 0;
        setNote({
          kind: warned ? "warn" : "ok",
          text: warned
            ? `Published — the live deck now serves this version. Warnings: ${(data.warnings ?? []).join(" ")}`
            : "Published — the live deck now serves this version.",
        });
      }
    } catch {
      setNote({ kind: "error", text: "Network error — try again." });
    }
    setBusy("idle");
  }, [busy, slug, saveDraft]);

  // Discard the draft, then reload the working copy (now the published html) into
  // the editor and refresh the preview token.
  const onDiscard = useCallback(async () => {
    if (busy !== "idle") return;
    setBusy("discarding");
    setNote(null);
    setIssues([]);
    try {
      const res = await fetch(`/api/admin/decks/${slug}/draft`, { method: "DELETE" });
      if (!res.ok) {
        setNote({ kind: "error", text: errorMessageFor(res.status) });
        setBusy("idle");
        return;
      }
      const get = await fetch(`/api/admin/decks/${slug}/draft`);
      const data = (await get.json().catch(() => ({}))) as DraftGetResponse;
      if (get.ok && typeof data.html === "string") {
        setDoc(data.html);
        setPreviewUrl(data.previewUrl ?? null);
      }
      setHasDraft(false);
      setDirty(false);
      setNote({ kind: "ok", text: "Draft discarded — back to the published version." });
    } catch {
      setNote({ kind: "error", text: "Network error — try again." });
    }
    setBusy("idle");
  }, [busy, slug, setDoc]);

  // Preview tokens expire (~5 min): re-GET just for a fresh signed URL, without
  // touching the editor buffer.
  const onRefreshPreview = useCallback(async () => {
    if (busy !== "idle") return;
    setBusy("refreshing");
    try {
      const res = await fetch(`/api/admin/decks/${slug}/draft`);
      const data = (await res.json().catch(() => ({}))) as DraftGetResponse;
      if (res.ok) setPreviewUrl(data.previewUrl ?? null);
    } catch {
      // keep the old frame; the button can be hit again
    }
    setBusy("idle");
  }, [busy, slug]);

  // ── render ────────────────────────────────────────────────────────────────

  if (phase === "load_error") {
    return (
      <section style={shellStyle}>
        <WorkbenchHeader hasDraft={false} dirty={false} />
        <div style={errorBoxStyle}>
          Couldn&apos;t load this deck&apos;s HTML — reload the page to try again.
        </div>
      </section>
    );
  }

  return (
    <section style={shellStyle}>
      <WorkbenchHeader hasDraft={hasDraft} dirty={dirty} />

      <div className="dwb-columns">
        {/* editor */}
        <div style={editorPaneStyle}>
          {phase === "loading" ? (
            <div style={paneNoteStyle}>Loading deck HTML…</div>
          ) : (
            <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />
          )}
        </div>

        {/* preview — the draft rendered through the REAL deck origin */}
        <div style={previewPaneStyle}>
          {previewUrl ? (
            <iframe
              key={previewUrl}
              src={previewUrl}
              title="Draft preview"
              // SECURITY: untrusted draft content → allow-scripts ONLY, never
              // allow-same-origin (opaque origin), identical to every other
              // uploaded-deck frame in the app.
              sandbox="allow-scripts"
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0, display: "block" }}
            />
          ) : (
            <div style={paneNoteStyle}>
              {phase === "loading"
                ? "Loading preview…"
                : "Preview unavailable — deck origin not configured."}
            </div>
          )}
        </div>
      </div>

      {/* actions */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={onSave}
          disabled={busy !== "idle" || phase !== "ready"}
          style={primaryBtnStyle(busy !== "idle" || phase !== "ready")}
        >
          {busy === "saving" ? "Saving…" : "Save draft"}
        </button>
        <button
          type="button"
          onClick={onPublish}
          disabled={busy !== "idle" || phase !== "ready"}
          style={publishBtnStyle(busy !== "idle" || phase !== "ready")}
        >
          {busy === "publishing" ? "Publishing…" : "Publish"}
        </button>
        <button
          type="button"
          onClick={onDiscard}
          disabled={busy !== "idle" || phase !== "ready" || !hasDraft}
          style={ghostBtnStyle(busy !== "idle" || phase !== "ready" || !hasDraft)}
        >
          {busy === "discarding" ? "Discarding…" : "Discard draft"}
        </button>
        <button
          type="button"
          onClick={onRefreshPreview}
          disabled={busy !== "idle" || phase !== "ready" || !previewUrl}
          style={ghostBtnStyle(busy !== "idle" || phase !== "ready" || !previewUrl)}
          title="Preview links are short-lived — grab a fresh one if the frame went stale."
        >
          {busy === "refreshing" ? "Refreshing…" : "Refresh preview"}
        </button>

        {note && (
          <span
            style={{
              fontSize: 13,
              color: note.kind === "error" ? "#C23B27" : note.kind === "warn" ? "#B08900" : "#4F7A2E",
            }}
          >
            {note.text}
          </span>
        )}
      </div>

      {issues.length > 0 && (
        <div style={errorBoxStyle}>
          <strong style={{ fontWeight: 600 }}>The deck isn&apos;t a valid VibeDeck bundle:</strong>
          <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
            {issues.map((issue, i) => (
              <li key={i} style={{ marginBottom: 4 }}>
                {issue}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p style={{ margin: 0, fontSize: 12, color: "#8A857C", lineHeight: 1.55 }}>
        Save keeps your changes as a private draft — the live deck is untouched until you Publish.
        The preview renders the draft exactly as the live deck is served (same origin, same
        sandbox, same runtime).
      </p>

      <style>{`
        .dwb-columns {
          display: flex;
          gap: 14px;
          align-items: stretch;
        }
        .dwb-columns > div { flex: 1 1 0; min-width: 0; }
        @media (max-width: 1040px) {
          .dwb-columns { flex-direction: column; }
          .dwb-columns > div { min-height: 320px; }
        }
      `}</style>
    </section>
  );
}

function WorkbenchHeader({ hasDraft, dirty }: { hasDraft: boolean; dirty: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
      <span
        style={{
          fontSize: 12,
          fontWeight: 500,
          letterSpacing: "0.2em",
          textTransform: "uppercase",
          color: "#9A958A",
        }}
      >
        Deck HTML — Workbench
      </span>
      <span
        style={{
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: "0.04em",
          padding: "3px 10px",
          borderRadius: 8,
          background: hasDraft ? "rgba(176,137,0,0.14)" : "rgba(79,122,46,0.12)",
          color: hasDraft ? "#B08900" : "#4F7A2E",
          whiteSpace: "nowrap",
        }}
      >
        {hasDraft ? "Unpublished draft" : "No draft — matches live"}
      </span>
      {dirty && <span style={{ fontSize: 13, color: "#B08900" }}>Unsaved changes</span>}
    </div>
  );
}

function errorMessageFor(status: number): string {
  if (status === 401) return "Session expired — sign in again.";
  if (status === 403) return "Blocked for security — reload the page.";
  if (status === 409) return "There is no draft to act on — save one first.";
  if (status === 413) return "Too large — a deck must stay under 2 MB.";
  if (status === 503) return "Database unavailable — try again later.";
  return "Something went wrong — try again.";
}

// ── styles (Solis palette, matching the notes editor cards) ─────────────────

const shellStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 14,
  padding: "20px 22px 22px",
  borderRadius: 18,
  background: "rgba(255,255,255,0.55)",
  border: "1px solid rgba(255,255,255,0.75)",
  backdropFilter: "blur(16px)",
  WebkitBackdropFilter: "blur(16px)",
  boxShadow: "0 10px 28px -18px rgba(60,55,45,0.4)",
};

const editorPaneStyle: React.CSSProperties = {
  position: "relative",
  height: 480,
  borderRadius: 12,
  overflow: "hidden",
  background: "#282c34", // one-dark's own background, so the rounding never flashes
  border: "1px solid rgba(60,55,45,0.14)",
};

const previewPaneStyle: React.CSSProperties = {
  position: "relative",
  height: 480,
  borderRadius: 12,
  overflow: "hidden",
  background: "#1B1A17",
  border: "1px solid rgba(60,55,45,0.14)",
};

const paneNoteStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 20,
  textAlign: "center",
  color: "rgba(244,242,236,0.6)",
  fontSize: 13,
  lineHeight: 1.5,
};

const errorBoxStyle: React.CSSProperties = {
  padding: "12px 16px",
  borderRadius: 12,
  background: "rgba(194,59,39,0.07)",
  border: "1px solid rgba(194,59,39,0.22)",
  color: "#8F2C1D",
  fontSize: 13.5,
  lineHeight: 1.5,
};

function primaryBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    height: 38,
    padding: "0 20px",
    borderRadius: 11,
    border: "none",
    cursor: disabled ? "default" : "pointer",
    background: disabled ? "#B9B5AD" : "#2C2A31",
    color: "#F4F2EC",
    fontFamily: "inherit",
    fontSize: 14,
    fontWeight: 500,
  };
}

function publishBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    height: 38,
    padding: "0 20px",
    borderRadius: 11,
    border: "none",
    cursor: disabled ? "default" : "pointer",
    background: disabled ? "#D9DEC4" : "#BFE048",
    color: disabled ? "#8A857C" : "#2C2A31",
    fontFamily: "inherit",
    fontSize: 14,
    fontWeight: 500,
  };
}

function ghostBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    height: 38,
    padding: "0 16px",
    borderRadius: 11,
    border: "1px solid rgba(60,55,45,0.18)",
    cursor: disabled ? "default" : "pointer",
    background: "transparent",
    color: disabled ? "#B9B5AD" : "#5E5A52",
    fontFamily: "inherit",
    fontSize: 13.5,
    fontWeight: 500,
  };
}
