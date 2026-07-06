"use client";

// AI sidebar (slide-system-rules.md §9). Calls the serverless function — never
// the model API directly. The function holds the OpenRouter key and grounds the
// answer in this deck. We send the name for usage tracking; we never persist the
// prompt or answer anywhere (the messages here live only in component memory).

import { useRef, useState } from "react";
import type { Deck } from "@/lib/types";
import styles from "./Sidebar.module.css";

interface Msg {
  role: "user" | "assistant" | "system";
  text: string;
  tokens?: number;
}

const PW_KEY = "presentation:classpw";

export function Sidebar({
  deck,
  slideIndex,
  name,
  onClose,
  onChangeName,
}: {
  deck: Deck;
  slideIndex: number;
  name: string;
  onClose: () => void;
  onChangeName: () => void;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  const scrollDown = () =>
    requestAnimationFrame(() =>
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }),
    );

  const push = (m: Msg) => setMessages((prev) => [...prev, m]);

  const send = async () => {
    const q = input.trim();
    if (!q || busy) return;
    // Prior user/assistant turns give the assistant context for follow-ups.
    const history = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.text }));
    push({ role: "user", text: q });
    setInput("");
    setBusy(true);
    scrollDown();
    try {
      const storedPw =
        typeof window !== "undefined" ? localStorage.getItem(PW_KEY) ?? "" : "";
      const pw = password || storedPw;
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, question: q, slug: deck.slug, slideIndex, password: pw, history }),
      });

      if (res.status === 401) {
        setNeedsPassword(true);
        push({
          role: "system",
          text: "This class needs a password to use the AI. Enter it below and resend.",
        });
        return;
      }
      if (res.status === 429) {
        const data = (await res.json().catch(() => ({}))) as { retryAfter?: number };
        push({
          role: "system",
          text: `You're going a bit fast — try again in ${data.retryAfter ?? "a few"} seconds.`,
        });
        return;
      }
      if (res.status === 503) {
        push({
          role: "system",
          text: "The AI isn't configured yet (no OpenRouter key set). The slides still work without it.",
        });
        return;
      }
      if (!res.ok) {
        push({ role: "system", text: "Something went wrong. Please try again." });
        return;
      }

      const data = (await res.json()) as { answer?: string; tokens?: number };
      push({ role: "assistant", text: data.answer ?? "(no answer)", tokens: data.tokens });
      if (pw) localStorage.setItem(PW_KEY, pw);
      setNeedsPassword(false);
    } catch {
      push({ role: "system", text: "Network error. Please try again." });
    } finally {
      setBusy(false);
      scrollDown();
    }
  };

  // Enter sends, Shift+Enter makes a newline. The global slide-nav handler
  // ignores keys while a textarea is focused, so arrows never move slides here.
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <aside className={styles.sidebar} aria-label="AI assistant">
      <header className={styles.header}>
        <div className={styles.headText}>
          <div className={styles.title}>Ask this deck</div>
          <button className={styles.nameBtn} onClick={onChangeName} title="Change name">
            {name} <span aria-hidden="true">✎</span>
          </button>
        </div>
        <button className={styles.close} onClick={onClose} aria-label="Close assistant">
          ✕
        </button>
      </header>

      <div className={styles.list} ref={listRef}>
        {messages.length === 0 && (
          <div className={styles.empty}>
            <p>
              Ask anything about <strong>{deck.title}</strong>.
            </p>
            <p className={styles.hint}>
              Answers come only from this deck. If it isn&rsquo;t in the slides, it&rsquo;ll
              say so.
            </p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`${styles.msg} ${styles[m.role]}`}>
            <div className={styles.bubble}>{m.text}</div>
            {m.tokens != null && <div className={styles.meta}>{m.tokens} tokens</div>}
          </div>
        ))}
        {busy && (
          <div className={`${styles.msg} ${styles.assistant}`}>
            <div className={styles.bubble}>
              <span className={styles.dots}>Thinking…</span>
            </div>
          </div>
        )}
      </div>

      {needsPassword && (
        <input
          className={styles.pw}
          type="password"
          placeholder="Class password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-label="Class password"
        />
      )}

      <div className={styles.inputRow}>
        <textarea
          className={styles.input}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask a question…"
          rows={2}
          aria-label="Ask a question"
        />
        <button
          className={styles.send}
          onClick={send}
          disabled={busy || !input.trim()}
          aria-label="Send question"
        >
          Send
        </button>
      </div>
    </aside>
  );
}
