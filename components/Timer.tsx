"use client";

// Presenter timer: elapsed time with start / pause / reset
// (slide-system-rules.md §5). Accumulates across pauses so it stays accurate.

import { useEffect, useRef, useState } from "react";
import styles from "./Timer.module.css";

function format(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function Timer() {
  const [running, setRunning] = useState(false);
  const [accumulated, setAccumulated] = useState(0);
  const [, force] = useState(0);
  const startAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => force((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, [running]);

  const elapsed =
    accumulated + (running && startAtRef.current ? Date.now() - startAtRef.current : 0);

  const toggle = () => {
    if (running) {
      setAccumulated((a) => a + (startAtRef.current ? Date.now() - startAtRef.current : 0));
      startAtRef.current = null;
      setRunning(false);
    } else {
      startAtRef.current = Date.now();
      setRunning(true);
    }
  };

  const reset = () => {
    startAtRef.current = running ? Date.now() : null;
    setAccumulated(0);
  };

  return (
    <div className={styles.timer}>
      <span className={styles.value} role="timer" aria-label="Elapsed time">
        {format(elapsed)}
      </span>
      <div className={styles.buttons}>
        <button type="button" onClick={toggle} className={styles.btn}>
          {running ? "Pause" : "Start"}
        </button>
        <button type="button" onClick={reset} className={styles.btn}>
          Reset
        </button>
      </div>
    </div>
  );
}
