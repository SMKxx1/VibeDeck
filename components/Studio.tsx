"use client";

// The Studio (Phase 3): a BYO-key, in-browser AI deck-authoring app. The presenter
// brings their OWN OpenRouter key (kept only in this browser's localStorage), types
// a prompt, and this component streams a generation from /api/studio/generate,
// renders it in a sandboxed live preview, and saves the result into their library
// via the admin routes. Styled to the warm "Solis" palette the dashboard/BuildGuide
// use (paper #ECEAE3 + frosted cards, dark-ink #2C2A31 buttons, lime #BFE048 accent).
//
// Three things here are load-bearing and are called out at their site:
//   1. SSE stream parsing — buffer across chunks, concatenate delta.content, stop
//      on [DONE]. (see runStream)
//   2. The live preview is a `sandbox="allow-scripts"` iframe with NO
//      allow-same-origin, so an AI-hallucinated/hostile deck runs in an OPAQUE
//      origin and cannot read this app's localStorage (the BYO key!), cookies, or
//      DOM. (see the <iframe> render)
//   3. Save is POST-first then PUT-by-slug so a re-save edits the same deck rather
//      than spawning duplicates. (see save)

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { injectRuntime } from "@/lib/inject-runtime";

// localStorage key for the presenter's OpenRouter credential. Namespaced so it
// never collides with the presenter-name key the dashboard stores.
const KEY_STORAGE = "vibedeck:openrouter-key";

// The admin upload route caps a deck at 2 MB and rejects a JSON envelope over its
// own Content-Length ceiling. Warn the presenter as the *html* nears 1.9 MB so they
// learn about it here rather than as a bare 413 on Save.
const SIZE_WARN_BYTES = 1_900_000;
const SIZE_MAX_BYTES = 2_000_000;

// Defense-in-depth CSP injected into every preview document. The opaque-origin
// sandbox already means a hostile deck has nothing on THIS origin to steal, but a
// locked-down CSP additionally denies it any network egress (no fetch/img/font to
// a remote host) — cheap insurance against exfil. 'unsafe-inline' is required
// because the deck's own <style>/<script> and the injected runtime are all inline.
const CSP_META =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ` +
  `script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:">`;

// ---- pure helpers -----------------------------------------------------------

// Models routinely wrap output in ```html … ``` despite being told not to. If the
// trimmed result opens with a fence, drop that opening fence line (```/```html) and
// any trailing fence, leaving the raw document (which should now start with
// <!doctype / <html / <deck-stage).
function stripMarkdownFences(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("```")) {
    const firstNl = s.indexOf("\n");
    s = firstNl === -1 ? s.slice(3) : s.slice(firstNl + 1); // drop ``` or ```html line
    s = s.replace(/\s*```\s*$/, ""); // drop the closing fence if present
  }
  return s.trim();
}

// Insert the CSP meta as the first thing inside <head>. If the model emitted no
// <head>, fall back to just after <html…>, else just after <!doctype…>, else
// (no landmarks at all) prepend. The fallback order matters: a <meta> placed
// BEFORE the doctype forces the preview into quirks mode, so we never land there
// while one exists. Keeps the meta BEFORE any deck script so the policy is already
// in force when the deck boots.
function injectCsp(html: string): string {
  const m =
    html.match(/<head[^>]*>/i) ||
    html.match(/<html[^>]*>/i) ||
    html.match(/<!doctype[^>]*>/i);
  if (m && m.index != null) {
    const at = m.index + m[0].length;
    return html.slice(0, at) + CSP_META + html.slice(at);
  }
  return CSP_META + html;
}

// Parse the cleaned deck client-side and list each slide's label. deck-stage's
// DIRECT <section> children are the slides (the platform contract); :scope keeps a
// nested <section> from being miscounted. Falls back to "Slide N" for an unlabelled
// slide so the rail is never blank.
function parseSlideLabels(html: string): string[] {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const stage = doc.querySelector("deck-stage");
    if (!stage) return [];
    return Array.from(stage.querySelectorAll(":scope > section")).map(
      (s, i) => s.getAttribute("data-label")?.trim() || `Slide ${i + 1}`,
    );
  } catch {
    return [];
  }
}

function byteLength(s: string): number {
  return new Blob([s]).size; // UTF-8 byte count, matching what the server measures
}

// Map a generate-proxy failure onto a plain presenter-facing sentence. Mirrors the
// exact error strings /api/studio/generate returns.
function generateErrorMessage(status: number, error?: string): string {
  switch (error) {
    case "invalid_key":
      return "OpenRouter rejected your key — check it and try again.";
    case "bad_key":
      return "That key doesn't look right — check it and re-save.";
    case "rate_limited":
      return "Slow down a moment, then try again.";
    case "empty_prompt":
      return "Describe the deck you want first.";
    case "prompt_too_long":
      return "That prompt is too long — shorten it.";
    case "payload_too_large":
      return "The current deck is too large to edit further — save it, then start fresh.";
    case "upstream_error":
    case "request_failed":
      return "Generation failed — try again in a moment.";
    default:
      if (status === 401) return "Session expired — sign in again.";
      if (status === 403) return "Blocked for security — reload and retry.";
      if (status === 429) return "Slow down a moment, then try again.";
      return "Generation failed — try again.";
  }
}

// Map an admin save failure (non-422; 422 is handled separately via issues[]).
function saveErrorMessage(status: number, error?: string): string {
  if (status === 401) return "Session expired — sign in again.";
  if (status === 403) return "Blocked for security — reload and retry.";
  if (status === 413 || error === "payload_too_large") return "Too large — decks are capped at 2 MB.";
  if (error === "missing_fields") return "Title and generated HTML are both required.";
  if (error === "not_found") return "That deck no longer exists — save again to create a fresh one.";
  if (error === "slug_conflict") return "A deck with that name already exists — rename it.";
  if (status === 503 || error === "database_unavailable") return "Database unavailable — try again.";
  return "Couldn't save — try again.";
}

// The shape of one OpenRouter stream frame we read (only the delta content matters).
interface StreamFrame {
  choices?: { delta?: { content?: string } }[];
}

// ---- shared style bits ------------------------------------------------------

const cardStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.5)",
  border: "1px solid rgba(255,255,255,0.72)",
  backdropFilter: "blur(16px)",
  WebkitBackdropFilter: "blur(16px)",
  boxShadow: "0 10px 28px -16px rgba(60,55,45,0.4)",
  borderRadius: 18,
  padding: 18,
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: "#9A958A",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  height: 40,
  padding: "0 12px",
  borderRadius: 11,
  border: "1px solid rgba(60,55,45,0.16)",
  background: "rgba(255,255,255,0.6)",
  fontFamily: "inherit",
  fontSize: 14,
  color: "#2C2932",
  outline: "none",
};

function primaryBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: 42,
    padding: "0 18px",
    borderRadius: 12,
    border: "none",
    cursor: disabled ? "default" : "pointer",
    fontFamily: "inherit",
    fontSize: 14,
    fontWeight: 500,
    background: "#2C2A31",
    color: "#F4F2EC",
    opacity: disabled ? 0.5 : 1,
    transition: "filter .15s, opacity .15s",
  };
}

function ghostBtnStyle(): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    height: 32,
    padding: "0 12px",
    borderRadius: 10,
    border: "1px solid rgba(60,55,45,0.16)",
    background: "rgba(255,255,255,0.5)",
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: 12.5,
    fontWeight: 500,
    color: "#6E6A62",
  };
}

function noticeStyle(tone: "error" | "warn" | "ok" | "muted"): React.CSSProperties {
  const palette = {
    error: { color: "#C23B27", background: "rgba(194,59,39,0.08)" },
    warn: { color: "#9A6A00", background: "rgba(180,120,0,0.10)" },
    ok: { color: "#2E8B5B", background: "rgba(46,139,91,0.10)" },
    muted: { color: "#6E6A62", background: "rgba(40,38,32,0.05)" },
  }[tone];
  return {
    fontSize: 12.5,
    fontWeight: 500,
    lineHeight: 1.45,
    borderRadius: 10,
    padding: "9px 12px",
    ...palette,
  };
}

// ---- component --------------------------------------------------------------

export function Studio() {
  // hasKey is null until we've read localStorage on mount — avoids a flash of the
  // key-entry form before we know whether a key already exists.
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [keyInput, setKeyInput] = useState("");

  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [streamChars, setStreamChars] = useState(0);
  const [genError, setGenError] = useState<string | null>(null);

  // The current generated (cleaned) deck. "" = nothing yet; when set, a follow-up
  // prompt EDITS it (sent as currentHtml so the model returns the whole doc back).
  const [deckHtml, setDeckHtml] = useState("");
  const [srcdoc, setSrcdoc] = useState("");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [slides, setSlides] = useState<string[]>([]);
  const [activeSlide, setActiveSlide] = useState(0);
  // Bumped on each new generation so the preview iframe fully remounts and the deck
  // boots clean rather than diffing srcDoc against a half-alive previous document.
  const [previewNonce, setPreviewNonce] = useState(0);

  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveIssues, setSaveIssues] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [saveWarnings, setSaveWarnings] = useState<string[]>([]);

  // The runtime JS is the same for every preview this session — fetch it once and
  // cache in a ref so re-previews don't re-hit the endpoint (and so caching it
  // never triggers an effect re-run).
  const runtimeRef = useRef<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Holds the in-flight generation's AbortController so Cancel can abort it. A fresh
  // one is created per generation and cleared when it settles — never reused (an
  // already-aborted controller would abort the next fetch instantly).
  const abortRef = useRef<AbortController | null>(null);

  const readKey = useCallback((): string => {
    try {
      return localStorage.getItem(KEY_STORAGE) || "";
    } catch {
      return "";
    }
  }, []);

  useEffect(() => {
    setHasKey(readKey().length > 0);
  }, [readKey]);

  const byteLen = useMemo(() => (deckHtml ? byteLength(deckHtml) : 0), [deckHtml]);

  // ---- key management -------------------------------------------------------

  function saveKey() {
    const k = keyInput.trim();
    if (!k) return;
    try {
      localStorage.setItem(KEY_STORAGE, k);
    } catch {
      /* storage disabled — the in-memory keyInput still lets one generation run,
         but we can't persist it; surface nothing noisy here. */
    }
    setKeyInput(""); // don't keep the raw key sitting in React state after saving
    setHasKey(true);
    setGenError(null);
  }

  function clearKey() {
    try {
      localStorage.removeItem(KEY_STORAGE);
    } catch {
      /* ignore */
    }
    setKeyInput("");
    setHasKey(false);
  }

  // ---- generation -----------------------------------------------------------

  // Read res.body as an SSE stream: buffer bytes across network chunks, split on
  // newlines, and only ACT on complete lines (a partial `data:` line simply stays
  // in the buffer until its terminating newline arrives — that IS the standard SSE
  // partial-line handling). For each `data:` line: skip comments (`:`)/blank lines,
  // stop on `[DONE]`, else JSON.parse and append choices[0].delta.content. Returns
  // the concatenated raw text.
  async function runStream(body: ReadableStream<Uint8Array>): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let acc = "";
    let stop = false;

    const handleLine = (raw: string) => {
      const line = raw.replace(/\r$/, "");
      if (!line || line.startsWith(":")) return; // blank or SSE comment/keepalive
      if (!line.startsWith("data:")) return; // event:/id: — not our payload
      const payload = line.slice(5).trim();
      if (!payload) return;
      if (payload === "[DONE]") {
        stop = true;
        return;
      }
      try {
        const frame = JSON.parse(payload) as StreamFrame;
        const delta = frame.choices?.[0]?.delta?.content;
        if (typeof delta === "string") {
          acc += delta;
          setStreamChars(acc.length);
        }
      } catch {
        // A complete data: line that isn't valid JSON (a genuinely malformed/odd
        // frame — NOT a split token, since we only reach here on a whole line).
        // Skip it; the stream keeps flowing.
      }
    };

    try {
      while (!stop) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          handleLine(line);
          if (stop) break;
        }
      }
      // Flush any final line the stream ended on without a trailing newline.
      if (!stop) {
        buffer += decoder.decode();
        if (buffer) handleLine(buffer);
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    return acc;
  }

  async function generate() {
    const key = readKey();
    if (!key) {
      setHasKey(false);
      setGenError("Add your OpenRouter key to generate.");
      return;
    }
    const p = prompt.trim();
    if (!p) {
      setGenError("Describe the deck you want first.");
      return;
    }

    setGenerating(true);
    setGenError(null);
    setStreamChars(0);
    setSaved(false);
    // Fresh controller per generation. Its signal is threaded into the fetch below;
    // because the proxy forwards with `signal: req.signal`, aborting here ALSO aborts
    // the upstream OpenRouter call, so a cancel stops the presenter's token spend too.
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch("/api/studio/generate", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          // The BYO key travels in this REQUEST HEADER only — never in the body,
          // never logged. The proxy uses it solely for the upstream Authorization.
          "x-openrouter-key": key,
        },
        // Include currentHtml ONLY when a deck already exists, so a follow-up prompt
        // edits it; a fresh generation omits it entirely.
        body: JSON.stringify(deckHtml ? { prompt: p, currentHtml: deckHtml } : { prompt: p }),
      });

      // Handle a non-2xx (JSON error) BEFORE trying to read the stream — an error
      // response is application/json, not an event-stream.
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (data.error === "missing_key" || data.error === "bad_key") {
          setHasKey(false);
        }
        setGenError(generateErrorMessage(res.status, data.error));
        return;
      }

      const rawText = await runStream(res.body);
      const cleaned = stripMarkdownFences(rawText);
      if (!cleaned) {
        setGenError("Generation returned nothing usable — try again.");
        return;
      }
      setDeckHtml(cleaned);
      setPreviewNonce((n) => n + 1);
    } catch (err) {
      // An abort is a deliberate user action (Cancel) — return to idle quietly,
      // leaving the prior deck (if any) untouched, and DON'T surface an error toast.
      // Any other throw is a real failure worth showing.
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setGenError("Generation failed — check your connection and try again.");
      }
    } finally {
      abortRef.current = null; // don't reuse a settled/aborted controller next time
      setGenerating(false);
    }
  }

  // Cancel an in-flight generation. Aborting the fetch rejects the stream read with
  // an AbortError (handled above) and tears down the upstream call.
  function cancelGenerate() {
    abortRef.current?.abort();
  }

  // ---- preview build (after generation completes) ---------------------------

  async function ensureRuntime(): Promise<string | null> {
    if (runtimeRef.current) return runtimeRef.current;
    try {
      // Same-origin GET carries the presenter cookie automatically (the endpoint is
      // presenter-gated). Returns the platform runtime JS as text.
      const res = await fetch("/api/studio/runtime");
      if (!res.ok) return null;
      const text = await res.text();
      runtimeRef.current = text;
      return text;
    } catch {
      return null;
    }
  }

  // Build the preview + slide rail whenever a NEW deck lands (keyed on deckHtml).
  // Deliberately runs only after a full generation completes — a half-streamed doc
  // has no </body> and would render broken, so we never preview per-frame.
  useEffect(() => {
    if (!deckHtml) {
      setSrcdoc("");
      setSlides([]);
      return;
    }
    setSlides(parseSlideLabels(deckHtml)); // pure client parse — no runtime needed
    setActiveSlide(0);
    setPreviewError(null);
    let cancelled = false;
    void (async () => {
      const rt = await ensureRuntime();
      if (cancelled) return;
      if (!rt) {
        setPreviewError("Couldn't load the live-preview runtime — reload and try again.");
        setSrcdoc("");
        return;
      }
      // injectCsp first (into <head>), then injectRuntime (before </body>) — the
      // ONE shared, escape-correct injection used by production too.
      setSrcdoc(injectRuntime(injectCsp(deckHtml), rt));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckHtml]);

  // Optional nicety: tell the previewed deck to jump to a slide. Safe because the
  // runtime only acts on a { type:"deck:goto", index } message; targetOrigin "*" is
  // fine (there is nothing secret to leak TO the opaque-origin child).
  function gotoSlide(index: number) {
    setActiveSlide(index);
    iframeRef.current?.contentWindow?.postMessage({ type: "deck:goto", index }, "*");
  }

  // ---- save -----------------------------------------------------------------

  async function save() {
    const t = title.trim();
    if (!t) {
      setSaveError("Give the deck a title first.");
      return;
    }
    if (!deckHtml) {
      setSaveError("Generate a deck before saving.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveIssues(null);
    setSaved(false);
    try {
      // First save POSTs (creates a new deck, returns its slug); every subsequent
      // save PUTs to that slug (a content replace) so we edit the SAME deck instead
      // of spawning duplicates in the library.
      const first = !slug;
      const res = await fetch(first ? "/api/admin/decks" : `/api/admin/decks/${slug}`, {
        method: first ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: t, html: deckHtml }),
      });

      if (res.status === 201 || res.status === 200) {
        const data = (await res.json().catch(() => ({}))) as { slug?: string; warnings?: string[] };
        if (data.slug) setSlug(data.slug);
        setSaveWarnings(Array.isArray(data.warnings) ? data.warnings : []);
        setSaved(true);
      } else if (res.status === 422) {
        const data = (await res.json().catch(() => ({}))) as { issues?: string[] };
        setSaveIssues(
          Array.isArray(data.issues) && data.issues.length
            ? data.issues
            : ["The generated deck isn't valid yet."],
        );
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setSaveError(saveErrorMessage(res.status, data.error));
      }
    } catch {
      setSaveError("Network error — try again.");
    } finally {
      setSaving(false);
    }
  }

  // ---- render ---------------------------------------------------------------

  const canGenerate = !generating && prompt.trim().length > 0 && hasKey !== false;
  const canSave = !saving && !!deckHtml && title.trim().length > 0 && byteLen <= SIZE_MAX_BYTES;

  return (
    <div
      style={{
        minHeight: "100vh",
        padding: "26px 30px 40px",
        background: "#ECEAE3",
        backgroundImage: "radial-gradient(rgba(40,38,32,0.045) 1px, transparent 1.4px)",
        backgroundSize: "22px 22px",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* ============ TOP BAR ============ */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24, marginBottom: 22 }}>
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
          <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
            <div style={{ fontSize: 19, fontWeight: 500, letterSpacing: "0.01em", color: "#262229" }}>Studio</div>
            <div style={{ fontSize: 11.5, fontWeight: 400, color: "#9A958A" }}>Generate a deck with your own AI key</div>
          </div>
        </div>

        <Link
          href="/dashboard"
          className="st-back"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            height: 40,
            textDecoration: "none",
            color: "#4A4750",
            fontSize: 13.5,
            fontWeight: 400,
            ...cardStyle,
            borderRadius: 12,
            padding: "0 16px",
          }}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
            <path d="M9.5 3.5L5 8l4.5 4.5" />
          </svg>
          Back to library
        </Link>
      </div>

      {/* ============ MAIN: left controls | right preview ============ */}
      <div style={{ display: "flex", gap: 20, flex: 1, minHeight: 0, alignItems: "stretch" }}>
        {/* ---- LEFT PANEL ---- */}
        <div
          style={{
            flex: "0 0 380px",
            display: "flex",
            flexDirection: "column",
            gap: 16,
            overflowY: "auto",
            paddingRight: 4,
          }}
        >
          {/* KEY */}
          <div style={cardStyle}>
            <div style={labelStyle}>Your OpenRouter key</div>
            {hasKey === null ? null : hasKey ? (
              <div style={{ marginTop: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, ...noticeStyle("ok") }}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 8.5L6.5 12L13 4.5" />
                  </svg>
                  Key stored in this browser.
                </div>
                <button type="button" onClick={clearKey} className="st-ghost" style={{ ...ghostBtnStyle(), marginTop: 10 }}>
                  Clear key
                </button>
              </div>
            ) : (
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                <input
                  type="password"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveKey();
                  }}
                  placeholder="sk-or-…"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-label="OpenRouter API key"
                  style={inputStyle}
                />
                <button
                  type="button"
                  onClick={saveKey}
                  disabled={!keyInput.trim()}
                  className="st-primary"
                  style={primaryBtnStyle(!keyInput.trim())}
                >
                  Save key
                </button>
                <div style={{ fontSize: 11.5, fontWeight: 400, lineHeight: 1.45, color: "#8A857C" }}>
                  Your key is stored only in this browser and is sent solely to generate decks on your behalf —
                  never saved on our servers.
                </div>
              </div>
            )}
          </div>

          {/* PROMPT */}
          <div style={cardStyle}>
            <div style={labelStyle}>{deckHtml ? "Edit the deck" : "Describe your deck"}</div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe the deck you want, or an edit to make…"
              rows={5}
              style={{
                ...inputStyle,
                height: "auto",
                minHeight: 108,
                padding: 12,
                marginTop: 12,
                resize: "vertical",
                lineHeight: 1.5,
              }}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button
                type="button"
                onClick={generate}
                disabled={!canGenerate}
                className="st-primary"
                style={{ ...primaryBtnStyle(!canGenerate), flex: 1 }}
              >
                {generating ? (
                  <>
                    <Spinner />
                    Generating… {streamChars.toLocaleString()} chars
                  </>
                ) : deckHtml ? (
                  "Apply edit"
                ) : (
                  "Generate"
                )}
              </button>
              {generating && (
                // Cancel aborts the in-flight fetch (and the upstream call with it).
                // Secondary/ghost look at the primary button's height so the two align.
                <button
                  type="button"
                  onClick={cancelGenerate}
                  className="st-cancel"
                  style={{
                    ...primaryBtnStyle(false),
                    flex: "0 0 auto",
                    background: "rgba(255,255,255,0.5)",
                    color: "#6E6A62",
                    border: "1px solid rgba(60,55,45,0.16)",
                  }}
                >
                  Cancel
                </button>
              )}
            </div>
            {genError && (
              <div style={{ ...noticeStyle("error"), marginTop: 12 }}>{genError}</div>
            )}
          </div>

          {/* SAVE */}
          <div style={cardStyle}>
            <div style={labelStyle}>Save to library</div>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Deck title"
              aria-label="Deck title"
              style={{ ...inputStyle, marginTop: 12 }}
            />
            <button
              type="button"
              onClick={save}
              disabled={!canSave}
              className="st-primary"
              style={{ ...primaryBtnStyle(!canSave), width: "100%", marginTop: 12 }}
            >
              {saving ? (
                <>
                  <Spinner />
                  Saving…
                </>
              ) : slug ? (
                "Save changes"
              ) : (
                "Save to library"
              )}
            </button>

            {/* Size heads-up before the server would 413. */}
            {byteLen > SIZE_WARN_BYTES && (
              <div style={{ ...noticeStyle("warn"), marginTop: 12 }}>
                This deck is {Math.round(byteLen / 1024).toLocaleString()} KB.
                {byteLen > SIZE_MAX_BYTES
                  ? " It's over the 2 MB limit — trim content before saving."
                  : " It's near the 2 MB limit — trim content if the save fails."}
              </div>
            )}

            {saveIssues && (
              <div style={{ ...noticeStyle("error"), marginTop: 12 }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>The generated deck isn&apos;t valid yet:</div>
                <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
                  {saveIssues.map((issue, i) => (
                    <li key={i}>{issue}</li>
                  ))}
                </ul>
                <div style={{ marginTop: 8, fontWeight: 400 }}>
                  Refine your prompt and generate again, then save.
                </div>
              </div>
            )}
            {saveError && <div style={{ ...noticeStyle("error"), marginTop: 12 }}>{saveError}</div>}
            {saved && (
              <div style={{ ...noticeStyle("ok"), marginTop: 12 }}>
                Saved ✓ — it&apos;s in your library as an unpublished deck.{" "}
                <Link href="/dashboard" style={{ color: "#2E8B5B", fontWeight: 600, textDecoration: "underline" }}>
                  Open the library
                </Link>{" "}
                to publish it.
                {saveWarnings.length > 0 && (
                  <div style={{ marginTop: 6, color: "#9A6A00" }}>
                    Warnings: {saveWarnings.join("; ")}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ---- RIGHT: preview + slide rail ---- */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", gap: 14 }}>
          {/* preview */}
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={labelStyle}>Live preview</div>
              {slides.length > 0 && (
                <div style={{ fontSize: 12, color: "#9A958A" }}>
                  {slides.length} slide{slides.length === 1 ? "" : "s"}
                </div>
              )}
            </div>

            <div
              style={{
                flex: 1,
                minHeight: 0,
                borderRadius: 18,
                overflow: "hidden",
                background: "#0b1020",
                border: "1px solid rgba(60,55,45,0.14)",
                boxShadow: "0 16px 38px -22px rgba(60,55,45,0.55)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                position: "relative",
              }}
            >
              {srcdoc ? (
                // SECURITY: sandbox="allow-scripts" WITHOUT allow-same-origin. This
                // forces the previewed (possibly AI-hallucinated or hostile) deck
                // into an OPAQUE origin, so it can run its scripts but CANNOT read
                // this app origin's localStorage (where the BYO key lives), cookies,
                // or DOM. Do NOT add allow-same-origin. previewNonce as key remounts
                // the frame per generation so each deck boots fresh.
                <iframe
                  key={previewNonce}
                  ref={iframeRef}
                  title="Deck preview"
                  srcDoc={srcdoc}
                  sandbox="allow-scripts"
                  style={{ width: "100%", height: "100%", border: "none", display: "block" }}
                />
              ) : (
                <div style={{ textAlign: "center", padding: 24, color: "rgba(242,246,252,0.5)" }}>
                  {previewError ? (
                    <span style={{ color: "#FFC7BC" }}>{previewError}</span>
                  ) : generating ? (
                    <span>Generating your deck…</span>
                  ) : (
                    <span>Your deck preview will appear here.</span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* slide rail */}
          {slides.length > 0 && (
            <div
              style={{
                flex: "0 0 150px",
                display: "flex",
                flexDirection: "column",
                gap: 6,
                overflowY: "auto",
                paddingRight: 2,
              }}
            >
              <div style={{ ...labelStyle, marginBottom: 2 }}>Slides</div>
              {slides.map((label, i) => {
                const active = i === activeSlide;
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => gotoSlide(i)}
                    className="st-rail"
                    title={label}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      textAlign: "left",
                      padding: "8px 10px",
                      borderRadius: 10,
                      border: active ? "1px solid rgba(60,55,45,0.22)" : "1px solid rgba(60,55,45,0.10)",
                      background: active ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.42)",
                      cursor: "pointer",
                      fontFamily: "inherit",
                      fontSize: 12,
                      fontWeight: active ? 500 : 400,
                      color: "#3A3730",
                    }}
                  >
                    <span
                      style={{
                        flex: "0 0 auto",
                        width: 18,
                        fontSize: 10.5,
                        fontWeight: 600,
                        color: active ? "#5B7A1E" : "#A29D92",
                      }}
                    >
                      {i + 1}
                    </span>
                    <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {label}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <style>{`
        .st-back:hover { background: rgba(255,255,255,0.66) !important; }
        .st-primary:not(:disabled):hover { filter: brightness(1.1); }
        .st-cancel:hover { background: rgba(255,255,255,0.72) !important; }
        .st-ghost:hover { background: rgba(255,255,255,0.72) !important; }
        .st-rail:hover { background: rgba(255,255,255,0.7) !important; }
      `}</style>
    </div>
  );
}

function Spinner() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" style={{ animation: "st-spin 0.7s linear infinite" }}>
      <circle cx="8" cy="8" r="6" stroke="rgba(244,242,236,0.3)" strokeWidth={2} />
      <path d="M8 2a6 6 0 0 1 6 6" stroke="#F4F2EC" strokeWidth={2} strokeLinecap="round" />
      <style>{`@keyframes st-spin { to { transform: rotate(360deg); } }`}</style>
    </svg>
  );
}
