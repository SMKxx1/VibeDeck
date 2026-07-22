"use client";

// The workshop chat sidebar. Grounded in the current slide (so "what did that
// mean?" works) and armed with live web search via the /api/ask endpoint. The
// key never touches the browser. Styled to the warm "Solis" palette.
//
// Answers stream token-by-token over SSE (#9); a row of "explain this slide
// differently" chips reframes the current slide on demand (#10); and up to three
// slide-grounded suggested questions lower the barrier to the blank input (#9).

import { useEffect, useRef, useState } from "react";

interface Citation {
  url: string;
  title?: string;
}
interface Message {
  role: "user" | "assistant";
  text: string;
  citations?: Citation[];
}

// "Explain this slide differently" chips (#10). Each posts /api/ask with a fixed
// `explain` mode (cached server-side, so repeats are instant) — no free-text
// question, no history, no streaming.
const EXPLAIN_CHIPS: { mode: string; label: string }[] = [
  { mode: "eli5", label: "Simpler" },
  { mode: "analogy", label: "Analogy" },
  { mode: "example", label: "Example" },
  { mode: "deeper", label: "Go deeper" },
];

// Map an /api/ask error code (and, as a fallback, the HTTP status) to a friendly
// line. Codes come from the JSON body a NON-streamed error returns.
function errorMessage(code: string | undefined, status: number): string {
  switch (code) {
    case "rate_limited":
      return "You're asking quickly — give it a few seconds.";
    case "ai_budget_exceeded":
      return "The AI tutor is at today's usage limit — ask the presenter.";
    case "unknown_deck":
      return "This deck isn't available.";
    case "ai_not_configured":
      return "The AI chat isn't configured yet (no API key). Ask the presenter.";
    case "timeout":
      return "That took too long — try again.";
    // `password_required` keeps the existing (generic) behavior; `request_failed`,
    // `upstream_error`, and anything unknown fall through to the default too.
    default:
      if (status === 503) return "The AI chat isn't configured yet (no API key). Ask the presenter.";
      return "Something went wrong — try again.";
  }
}

// Lightweight inline formatting for answers: **bold** and *italic*. Newlines are
// preserved by the bubble's white-space:pre-wrap.
function renderText(text: string): React.ReactNode {
  const nodes: React.ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1] !== undefined) nodes.push(<strong key={k++}>{m[1]}</strong>);
    else nodes.push(<em key={k++}>{m[2]}</em>);
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const suggestPill: React.CSSProperties = {
  textAlign: "left",
  border: "1px solid rgba(60,55,45,0.16)",
  background: "rgba(255,255,255,0.72)",
  color: "#4A463F",
  borderRadius: 12,
  padding: "7px 11px",
  fontSize: 12.5,
  lineHeight: 1.35,
  fontFamily: "inherit",
  cursor: "pointer",
};

const explainPill: React.CSSProperties = {
  border: "1px solid rgba(60,55,45,0.16)",
  background: "rgba(255,255,255,0.55)",
  color: "#6E6A62",
  borderRadius: 999,
  padding: "5px 11px",
  fontSize: 12,
  fontWeight: 500,
  fontFamily: "inherit",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

export function LiveChat({
  slug,
  slideIndex,
  slideLabel,
  name,
  onClose,
}: {
  slug: string;
  slideIndex: number;
  slideLabel: string;
  name: string;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [accessState, setAccessState] = useState<"checking" | "locked" | "unlocked">("checking");
  const [accessPassword, setAccessPassword] = useState("");
  const [accessBusy, setAccessBusy] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The in-flight ask (stream or explain chip): the Stop control aborts it, and
  // aborting the fetch tells the server to stop generating.
  const askAbortRef = useRef<AbortController | null>(null);
  // The in-flight suggest request, so a slide change can cancel a stale one.
  const suggestAbortRef = useRef<AbortController | null>(null);

  // Autoscroll as messages change — including on every streamed token, since each
  // delta updates `messages`. Preserves the original smooth-scroll behavior.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  // Abort anything in flight when the sidebar unmounts.
  useEffect(() => {
    return () => {
      askAbortRef.current?.abort();
      suggestAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/ai-access", { cache: "no-store", signal: ac.signal })
      .then((res) => (res.ok ? res.json() : { required: true, unlocked: false }))
      .then((data: { required?: boolean; unlocked?: boolean }) => {
        if (ac.signal.aborted) return;
        setAccessState(data.required && !data.unlocked ? "locked" : "unlocked");
      })
      .catch((err: unknown) => {
        if ((err as { name?: string })?.name !== "AbortError") setAccessState("locked");
      });
    return () => ac.abort();
  }, []);

  // Suggested questions (#9). Refetch when the active slide changes (and on
  // mount): clear the stale list immediately, debounce so scrubbing through
  // slides doesn't fire a request per slide, and abort a still-pending suggest
  // when the slide changes again. This endpoint never errors — it returns
  // { questions: [] } on any problem — so there's no error UI, just nothing.
  useEffect(() => {
    setSuggestions([]);
    if (accessState !== "unlocked") return;
    const ac = new AbortController();
    suggestAbortRef.current = ac;
    const t = setTimeout(() => {
      fetch("/api/ask/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, slideIndex }),
        signal: ac.signal,
      })
        .then((res) => (res.ok ? res.json() : { questions: [] }))
        .then((data: { questions?: unknown }) => {
          if (ac.signal.aborted) return;
          const qs = Array.isArray(data.questions)
            ? (data.questions as unknown[])
                .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
                .map((q) => q.trim())
                .slice(0, 3)
            : [];
          setSuggestions(qs);
        })
        .catch(() => {
          /* aborted or network — leave suggestions empty */
        });
    }, 350);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [slug, slideIndex, accessState]);

  // Streamed question path (#1/#9). Appends the question, then reads the SSE
  // stream and grows the assistant bubble token-by-token. `history` is captured
  // by the caller BEFORE the new question is appended, exactly as before.
  async function streamAsk(q: string, history: { role: "user" | "assistant"; content: string }[]) {
    setError(null);
    setSuggestions([]); // this turn consumes the current nudges
    setMessages((m) => [...m, { role: "user", text: q }]);
    setBusy(true);

    const ac = new AbortController();
    askAbortRef.current = ac;

    let started = false; // has the assistant bubble been appended yet?
    let acc = ""; // accumulated answer text
    let gotDone = false;

    // Grow the in-progress assistant bubble. `started`/`acc` are mutated here in
    // the handler (not inside the state updater), so the updater stays pure.
    const appendDelta = (c: string) => {
      acc += c;
      if (!started) {
        started = true;
        setMessages((m) => [...m, { role: "assistant", text: acc }]);
      } else {
        setMessages((m) => {
          const copy = m.slice();
          copy[copy.length - 1] = { ...copy[copy.length - 1], text: acc };
          return copy;
        });
      }
    };

    const finalize = (cites: Citation[]) => {
      setMessages((m) => {
        if (!started) {
          return [
            ...m,
            {
              role: "assistant",
              text: acc || "I couldn't find an answer — try rephrasing, or ask the presenter.",
              citations: cites.length ? cites : undefined,
            },
          ];
        }
        const copy = m.slice();
        copy[copy.length - 1] = { ...copy[copy.length - 1], text: acc, citations: cites.length ? cites : undefined };
        return copy;
      });
    };

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, slideIndex, slideLabel, name, question: q, history, stream: true }),
        signal: ac.signal,
      });

      // Before it streams, the server may still return a non-200 JSON error (e.g.
      // 429). If it isn't an OK event-stream, read it as JSON and map the error —
      // don't try to stream a non-stream body.
      const ct = res.headers.get("Content-Type") || "";
      if (!res.ok || !ct.includes("text/event-stream")) {
        let code: string | undefined;
        try {
          code = ((await res.json()) as { error?: string }).error;
        } catch {
          /* non-JSON body */
        }
        if (code === "password_required") {
          setAccessState("locked");
          setError(null);
          return;
        }
        setError(errorMessage(code, res.status));
        return;
      }
      if (!res.body) {
        setError(errorMessage(undefined, res.status));
        return;
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line || line.startsWith(":") || !line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          let evt: { t?: string; c?: unknown; citations?: unknown };
          try {
            evt = JSON.parse(raw) as { t?: string; c?: unknown; citations?: unknown };
          } catch {
            continue; // skip an unparseable line
          }
          if (evt.t === "d") {
            if (typeof evt.c === "string" && evt.c) appendDelta(evt.c);
          } else if (evt.t === "done") {
            gotDone = true;
            const rawCites = Array.isArray(evt.citations) ? (evt.citations as unknown[]) : [];
            const cites: Citation[] = rawCites
              .map((c) => (c && typeof c === "object" ? (c as { url?: unknown; title?: unknown }) : {}))
              .filter((c): c is { url: string; title?: unknown } => typeof c.url === "string" && c.url.length > 0)
              .map((c) => ({ url: c.url, title: typeof c.title === "string" ? c.title : undefined }));
            finalize(cites);
          } else if (evt.t === "error") {
            // Mid-stream fault: if nothing streamed, show the generic error;
            // otherwise keep whatever tokens already arrived.
            gotDone = true;
            if (!started) setError(errorMessage("request_failed", 500));
          }
        }
      }
      // Stream ended without a clean finish and nothing arrived → generic error.
      if (!gotDone && !started) setError(errorMessage(undefined, 0));
    } catch (err) {
      // An abort (the Stop button, or unmount) just stops — keep what streamed.
      if ((err as { name?: string })?.name !== "AbortError" && !started) {
        setError(errorMessage(undefined, 0));
      }
    } finally {
      if (askAbortRef.current === ac) askAbortRef.current = null;
      setBusy(false);
    }
  }

  // Explain-chip path (#10). Non-streamed JSON, cached server-side. No question,
  // no history.
  async function explainChip(mode: string, label: string) {
    if (busy) return;
    setError(null);
    setMessages((m) => [...m, { role: "user", text: `🔎 Explain this slide — ${label.toLowerCase()}` }]);
    setBusy(true);

    const ac = new AbortController();
    askAbortRef.current = ac;
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, slideIndex, slideLabel, name, explain: mode }),
        signal: ac.signal,
      });
      if (!res.ok) {
        let code: string | undefined;
        try {
          code = ((await res.json()) as { error?: string }).error;
        } catch {
          /* non-JSON body */
        }
        if (code === "password_required") {
          setAccessState("locked");
          setError(null);
          return;
        }
        setError(errorMessage(code, res.status));
      } else {
        const data = (await res.json()) as { answer?: string; citations?: Citation[] };
        setMessages((m) => [
          ...m,
          { role: "assistant", text: data.answer ?? "", citations: data.citations },
        ]);
      }
    } catch (err) {
      if ((err as { name?: string })?.name !== "AbortError") setError(errorMessage(undefined, 0));
    } finally {
      if (askAbortRef.current === ac) askAbortRef.current = null;
      setBusy(false);
    }
  }

  function send(e: React.FormEvent) {
    e.preventDefault();
    const q = input.trim();
    if (!q || busy) return;
    // Prior turns give the assistant conversational context for follow-ups.
    // Capture from state before we append the new question.
    const history = messages.slice(-8).map((m) => ({ role: m.role, content: m.text }));
    setInput("");
    void streamAsk(q, history);
  }

  function askSuggestion(q: string) {
    if (busy) return;
    const history = messages.slice(-8).map((m) => ({ role: m.role, content: m.text }));
    void streamAsk(q, history);
  }

  function stop() {
    askAbortRef.current?.abort();
  }

  async function unlockAi(e: React.FormEvent) {
    e.preventDefault();
    if (!accessPassword || accessBusy) return;
    setAccessBusy(true);
    setAccessError(null);
    try {
      const res = await fetch("/api/ai-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: accessPassword }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setAccessError(
          data.error === "rate_limited"
            ? "Too many attempts — wait a few minutes."
            : "That class code isn't correct.",
        );
        return;
      }
      setAccessPassword("");
      setAccessState("unlocked");
    } catch {
      setAccessError("Couldn't verify the class code — try again.");
    } finally {
      setAccessBusy(false);
    }
  }

  const lastRole = messages.length ? messages[messages.length - 1].role : null;
  // Show "thinking…" while a request is in flight and no assistant reply has
  // started streaming yet (covers both the pre-first-token gap and the chip path).
  const showThinking = busy && lastRole !== "assistant";
  const canSend = !!input.trim();

  return (
    <aside
      style={{
        width: "min(380px, 92vw)",
        flex: "0 0 auto",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "rgba(248,247,243,0.92)",
        borderLeft: "1px solid rgba(60,55,45,0.14)",
        backdropFilter: "blur(18px)",
        WebkitBackdropFilter: "blur(18px)",
        fontFamily: '"Outfit", system-ui, sans-serif',
      }}
    >
      <header style={{ padding: "16px 18px 12px", borderBottom: "1px solid rgba(60,55,45,0.12)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "#262229" }}>Ask about this slide</div>
          <button onClick={onClose} aria-label="Close chat" style={{ border: "none", background: "transparent", fontSize: 20, lineHeight: 1, cursor: "pointer", color: "#8A857C" }}>
            ×
          </button>
        </div>
        <div style={{ fontSize: 12, color: "#8A857C", marginTop: 3 }}>
          Slide {slideIndex + 1}{slideLabel ? ` · ${slideLabel}` : ""}
        </div>
      </header>

      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "16px 16px 8px", display: "flex", flexDirection: "column", gap: 12 }}>
        {accessState === "checking" && (
          <div style={{ fontSize: 13.5, color: "#6E6A62" }}>Checking AI access…</div>
        )}
        {accessState === "locked" && (
          <div style={{ fontSize: 13.5, fontWeight: 300, lineHeight: 1.55, color: "#6E6A62" }}>
            Enter the class code to use the AI tutor. The code is valid for this browser for eight hours.
          </div>
        )}
        {accessState === "unlocked" && messages.length === 0 && !busy && (
          <div style={{ fontSize: 13.5, fontWeight: 300, lineHeight: 1.55, color: "#6E6A62" }}>
            Hi {name.split(" ")[0]} 👋 — ask me anything about what’s on screen. I can also look things up on the web.
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              alignSelf: m.role === "user" ? "flex-end" : "flex-start",
              maxWidth: "88%",
              padding: "10px 13px",
              borderRadius: 14,
              fontSize: 13.5,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              color: m.role === "user" ? "#F4F2EC" : "#2C2A31",
              background: m.role === "user" ? "#2C2A31" : "rgba(255,255,255,0.85)",
              border: m.role === "user" ? "none" : "1px solid rgba(60,55,45,0.1)",
            }}
          >
            {m.role === "assistant" ? renderText(m.text) : m.text}
            {m.citations && m.citations.length > 0 && (
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                {m.citations.map((c, ci) => (
                  <a key={ci} href={c.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11.5, color: "#6b5a36", textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    🔗 {c.title || c.url}
                  </a>
                ))}
              </div>
            )}
          </div>
        ))}
        {showThinking && (
          <div style={{ alignSelf: "flex-start", fontSize: 13, color: "#8A857C", fontStyle: "italic" }}>thinking…</div>
        )}
        {error && <div style={{ fontSize: 12.5, color: "#C23B27" }}>{error}</div>}
      </div>

      <div style={{ borderTop: "1px solid rgba(60,55,45,0.12)", background: "rgba(248,247,243,0.55)" }}>
        {accessState === "locked" ? (
          <form onSubmit={unlockAi} style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="password"
                value={accessPassword}
                onChange={(e) => setAccessPassword(e.target.value)}
                placeholder="Class code"
                autoComplete="current-password"
                maxLength={256}
                autoFocus
                style={{
                  flex: 1,
                  height: 42,
                  padding: "0 14px",
                  borderRadius: 12,
                  border: "1px solid rgba(60,55,45,0.18)",
                  background: "rgba(255,255,255,0.85)",
                  fontFamily: "inherit",
                  fontSize: 14,
                  color: "#2C2A31",
                }}
              />
              <button
                type="submit"
                disabled={!accessPassword || accessBusy}
                style={{
                  minWidth: 82,
                  height: 42,
                  borderRadius: 12,
                  border: "none",
                  background: accessPassword && !accessBusy ? "#2C2A31" : "#B7B2A8",
                  color: "#F4F2EC",
                  fontFamily: "inherit",
                  cursor: accessPassword && !accessBusy ? "pointer" : "default",
                }}
              >
                {accessBusy ? "Checking…" : "Unlock"}
              </button>
            </div>
            {accessError && <div role="alert" style={{ fontSize: 12.5, color: "#C23B27" }}>{accessError}</div>}
          </form>
        ) : accessState === "checking" ? null : (
          <>
        {/* Suggested questions (#9) — tapping one submits it as a streamed question. */}
        {!busy && suggestions.length > 0 && (
          <div style={{ padding: "10px 12px 2px", display: "flex", flexDirection: "column", gap: 6 }}>
            {suggestions.map((q, i) => (
              <button key={i} type="button" onClick={() => askSuggestion(q)} style={suggestPill}>
                💡 {q}
              </button>
            ))}
          </div>
        )}

        {/* Explain-this-slide-differently chips (#10). */}
        {!busy && (
          <div
            style={{
              padding: suggestions.length ? "6px 12px 2px" : "10px 12px 2px",
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span style={{ fontSize: 11, color: "#A8A399", marginRight: 1 }}>Explain:</span>
            {EXPLAIN_CHIPS.map((chip) => (
              <button key={chip.mode} type="button" onClick={() => void explainChip(chip.mode, chip.label)} style={explainPill}>
                {chip.label}
              </button>
            ))}
          </div>
        )}

        <form onSubmit={send} style={{ padding: 12, display: "flex", gap: 8 }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask a question…"
            style={{
              flex: 1,
              height: 42,
              padding: "0 14px",
              borderRadius: 12,
              border: "1px solid rgba(60,55,45,0.18)",
              background: "rgba(255,255,255,0.85)",
              fontFamily: "inherit",
              fontSize: 14,
              color: "#2C2A31",
              outline: "none",
            }}
          />
          <button
            type={busy ? "button" : "submit"}
            onClick={busy ? stop : undefined}
            disabled={!busy && !canSend}
            style={{
              width: 42,
              height: 42,
              borderRadius: 12,
              border: "none",
              background: busy ? "#C23B27" : canSend ? "#2C2A31" : "#B7B2A8",
              color: "#F4F2EC",
              cursor: busy || canSend ? "pointer" : "default",
              fontSize: busy ? 13 : 16,
            }}
            aria-label={busy ? "Stop" : "Send"}
          >
            {busy ? "■" : "↑"}
          </button>
        </form>
          </>
        )}
      </div>
    </aside>
  );
}
