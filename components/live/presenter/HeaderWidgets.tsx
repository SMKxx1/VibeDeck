"use client";

// The presenter console's header widgets: the roster stat (#1), the help meter
// (#2), the comprehension-checkpoint actions and the session timer. Moved verbatim
// from PresenterConsole — the shell owns all of their state and passes it down.

import { useEffect, useRef, useState } from "react";
import type { Viewer } from "./shared";

// Header stat + expandable roster (#1). Click to reveal each viewer's name and
// slide number; the breakdown is computed against the presenter's current slide.
export function PresenceStat({
  watching,
  following,
  exploring,
  behind,
  viewers,
  open,
  onOpenChange,
}: {
  watching: number;
  following: number;
  exploring: number;
  behind: number;
  viewers: Viewer[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onOpenChange(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onOpenChange]);

  return (
    <span ref={wrapRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        onClick={() => onOpenChange(!open)}
        title="Show who's watching"
        aria-expanded={open}
        style={{
          background: open ? "rgba(255,255,255,0.08)" : "transparent",
          border: "1px solid rgba(255,255,255,0.14)",
          color: "#E7E4DC",
          fontFamily: "inherit",
          fontSize: 13,
          fontWeight: 500,
          cursor: "pointer",
          padding: "5px 10px",
          borderRadius: 8,
          whiteSpace: "nowrap",
        }}
      >
        👁 {watching} watching
        {watching > 0 && (
          <span style={{ color: "#9A958A", fontWeight: 400 }}>
            {" · "}
            {following} following · {exploring} exploring · {behind} behind
          </span>
        )}
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 10px)",
            left: 0,
            zIndex: 60,
            minWidth: 230,
            maxHeight: 320,
            overflowY: "auto",
            padding: "10px 12px",
            borderRadius: 12,
            background: "#2B2928",
            border: "1px solid rgba(255,255,255,0.14)",
            boxShadow: "0 18px 40px -20px rgba(0,0,0,0.7)",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {viewers.length === 0 ? (
            <div style={{ color: "#9A958A", fontSize: 12 }}>No one watching yet.</div>
          ) : (
            viewers.map((v, i) => (
              <div key={`${v.name}-${i}`} style={{ display: "flex", justifyContent: "space-between", gap: 14, fontSize: 12.5 }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.name}</span>
                <span style={{ color: "#9A958A", whiteSpace: "nowrap" }}>
                  slide {v.index + 1}
                  {v.follow ? " · following" : ""}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </span>
  );
}

// Persistent "help" meter (#2): decaying counts of viewers who feel lost / want
// you to slow down. Amber/red so it catches the eye; clears as counts hit 0.
export function HelpMeter({ lost, slow }: { lost: number; slow: number }) {
  if (lost <= 0 && slow <= 0) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {lost > 0 && (
        <span style={helpChip("#FF6B4A", "rgba(181,51,31,0.22)", "rgba(255,107,74,0.5)")}>
          ❓ {lost} feel{lost === 1 ? "s" : ""} lost
        </span>
      )}
      {slow > 0 && (
        <span style={helpChip("#F0B24A", "rgba(201,138,46,0.2)", "rgba(240,178,74,0.5)")}>
          🐢 {slow} want{slow === 1 ? "s" : ""} you to slow down
        </span>
      )}
    </div>
  );
}

function helpChip(fg: string, bg: string, border: string): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    height: 28,
    padding: "0 12px",
    borderRadius: 999,
    background: bg,
    color: fg,
    border: `1px solid ${border}`,
    fontSize: 12.5,
    fontWeight: 600,
    whiteSpace: "nowrap",
    boxShadow: `0 0 0 3px ${bg}`,
  };
}

// Comprehension checkpoint: two one-tap fixes that appear next to the help meter
// when the "I'm lost" count crosses LOST_THRESHOLD — broadcast an AI recap of the
// current slide to every viewer, or draft an AI knowledge-check for review.
// "Clear recap" stays visible while a recap is live, even after the meter decays.
export function ComprehensionCheck({
  show,
  recapActive,
  sending,
  error,
  pollLive,
  onSendRecap,
  onClearRecap,
  onLaunchCheck,
}: {
  show: boolean;
  recapActive: boolean;
  sending: boolean;
  error: string | null;
  pollLive: boolean;
  onSendRecap: () => void;
  onClearRecap: () => void;
  onLaunchCheck: () => void;
}) {
  if (!show && !recapActive) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" }}>
      {show && (
        <button
          onClick={onSendRecap}
          disabled={sending || recapActive}
          style={checkBtn(sending || recapActive)}
          title={recapActive ? "A recap is already live" : "Broadcast an AI recap of this slide to every viewer"}
        >
          {sending ? "Sending…" : "📢 Send recap"}
        </button>
      )}
      {show && (
        <button
          onClick={onLaunchCheck}
          disabled={pollLive}
          style={checkBtn(pollLive)}
          title={pollLive ? "A poll is already live" : "Draft an AI knowledge-check on this slide for review"}
        >
          ✨ Launch check
        </button>
      )}
      {recapActive && (
        <button onClick={onClearRecap} style={checkBtn(false)} title="Remove the recap overlay from every viewer">
          Clear recap
        </button>
      )}
      {error && <span style={{ fontSize: 11.5, color: "#FF8A6B", fontWeight: 500 }}>{error}</span>}
    </div>
  );
}

function checkBtn(muted: boolean): React.CSSProperties {
  return {
    height: 28,
    padding: "0 11px",
    borderRadius: 999,
    border: "1px solid rgba(240,178,74,0.5)",
    background: "rgba(240,178,74,0.14)",
    color: "#F0C97E",
    cursor: muted ? "default" : "pointer",
    fontFamily: "inherit",
    fontSize: 12,
    fontWeight: 600,
    whiteSpace: "nowrap",
    opacity: muted ? 0.6 : 1,
  };
}

export function ConsoleTimer() {
  const [elapsed, setElapsed] = useState(0);
  const [running, setRunning] = useState(true);
  const startRef = useRef<number | null>(null);
  const accRef = useRef(0);

  useEffect(() => {
    if (!running) return;
    if (startRef.current == null) startRef.current = performance.now();
    const id = window.setInterval(() => {
      const base = startRef.current ?? performance.now();
      setElapsed(accRef.current + (performance.now() - base));
    }, 250);
    return () => window.clearInterval(id);
  }, [running]);

  const mm = Math.floor(elapsed / 60000);
  const ss = Math.floor((elapsed % 60000) / 1000);
  const label = `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;

  const toggle = () => {
    if (running) {
      const base = startRef.current ?? performance.now();
      accRef.current += performance.now() - base;
      startRef.current = null;
    } else {
      startRef.current = performance.now();
    }
    setRunning((r) => !r);
  };
  const reset = () => {
    accRef.current = 0;
    startRef.current = running ? performance.now() : null;
    setElapsed(0);
  };

  const mini: React.CSSProperties = { border: "none", background: "rgba(255,255,255,0.12)", color: "#E7E4DC", width: 26, height: 26, borderRadius: 7, fontSize: 12, cursor: "pointer" };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontVariantNumeric: "tabular-nums" }}>
      <span style={{ fontSize: 18, fontWeight: 600 }}>{label}</span>
      <button onClick={toggle} title={running ? "Pause" : "Start"} style={mini}>{running ? "❚❚" : "▸"}</button>
      <button onClick={reset} title="Reset" style={mini}>↺</button>
    </span>
  );
}
