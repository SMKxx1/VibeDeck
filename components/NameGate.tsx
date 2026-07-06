"use client";

// First-load display-name prompt (slide-system-rules.md §9). The name is kept
// in the browser and sent with every AI request; we never store what's asked.

import { useEffect, useRef, useState } from "react";
import styles from "./NameGate.module.css";

export function NameGate({ onSubmit }: { onSubmit: (name: string) => void }) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = (name: string) => {
    const trimmed = name.trim().slice(0, 40);
    if (!trimmed) return;
    onSubmit(trimmed);
  };

  return (
    <div
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-labelledby="namegate-title"
    >
      <div className={styles.card}>
        <h2 id="namegate-title" className={styles.title}>
          What should we call you?
        </h2>
        <p className={styles.sub}>
          Your name stays in this browser and is sent with AI questions so usage can be
          tracked. We never store what you ask.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(value);
          }}
        >
          <input
            ref={inputRef}
            className={styles.input}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="e.g. Alex"
            maxLength={40}
            aria-label="Display name"
          />
          <div className={styles.row}>
            <button type="submit" className={styles.primary} disabled={!value.trim()}>
              Join
            </button>
            <button
              type="button"
              className={styles.ghost}
              onClick={() => submit("Presenter")}
            >
              I&rsquo;m presenting
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
