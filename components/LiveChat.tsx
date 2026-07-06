"use client";

// The workshop chat sidebar. Grounded in the current slide (so "what did that
// mean?" works) and armed with live web search via the /api/ask endpoint. The
// key never touches the browser. Styled to the warm "Solis" palette.

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
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const q = input.trim();
    if (!q || busy) return;
    setInput("");
    setError(null);
    setMessages((m) => [...m, { role: "user", text: q }]);
    setBusy(true);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, slideIndex, slideLabel, name, question: q }),
      });
      if (res.status === 503) {
        setError("The AI chat isn't configured yet (no API key). Ask the presenter.");
      } else if (res.status === 429) {
        setError("You're asking quickly — give it a few seconds and try again.");
      } else if (!res.ok) {
        setError("Something went wrong reaching the assistant. Try again.");
      } else {
        const data = (await res.json()) as { answer: string; citations?: Citation[] };
        setMessages((m) => [...m, { role: "assistant", text: data.answer, citations: data.citations }]);
      }
    } catch {
      setError("Network hiccup — try again.");
    } finally {
      setBusy(false);
    }
  }

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
        {messages.length === 0 && !busy && (
          <div style={{ fontSize: 13.5, fontWeight: 300, lineHeight: 1.55, color: "#6E6A62" }}>
            Hi {name.split(" ")[0]} 👋 — ask me anything about what's on screen. I can also look things up on the web.
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
        {busy && (
          <div style={{ alignSelf: "flex-start", fontSize: 13, color: "#8A857C", fontStyle: "italic" }}>thinking…</div>
        )}
        {error && <div style={{ fontSize: 12.5, color: "#C23B27" }}>{error}</div>}
      </div>

      <form onSubmit={send} style={{ padding: 12, borderTop: "1px solid rgba(60,55,45,0.12)", display: "flex", gap: 8 }}>
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
          type="submit"
          disabled={busy || !input.trim()}
          style={{
            width: 42,
            height: 42,
            borderRadius: 12,
            border: "none",
            background: busy || !input.trim() ? "#B7B2A8" : "#2C2A31",
            color: "#F4F2EC",
            cursor: busy || !input.trim() ? "default" : "pointer",
            fontSize: 16,
          }}
          aria-label="Send"
        >
          ↑
        </button>
      </form>
    </aside>
  );
}
