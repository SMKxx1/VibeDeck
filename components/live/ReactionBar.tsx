"use client";

// Shared viewer reaction row (#2) — the SINGLE implementation used by both
// LiveDeck and UploadedDeckFrame. Extracted verbatim from LiveDeck.

import { useEffect, useRef, useState } from "react";
import { REACTIONS, type SignalKind } from "./types";
import { glassChip } from "./chrome";

// A compact reaction row (#2). Each tap fires one signal, pulses the button, and
// starts a ~3s local cooldown so a viewer can't machine-gun it (the server also
// rate-limits). "I'm lost" is styled distinctly to stand out.
export function ReactionBar({ onSend }: { onSend: (kind: SignalKind) => void }) {
  const [cooling, setCooling] = useState<Record<string, boolean>>({});
  const [pulse, setPulse] = useState<SignalKind | null>(null);
  const timers = useRef<number[]>([]);
  useEffect(
    () => () => {
      timers.current.forEach((t) => window.clearTimeout(t));
    },
    [],
  );

  const tap = (kind: SignalKind) => {
    if (cooling[kind]) return;
    onSend(kind);
    setPulse(kind);
    setCooling((c) => ({ ...c, [kind]: true }));
    timers.current.push(
      window.setTimeout(() => setPulse((p) => (p === kind ? null : p)), 420),
      window.setTimeout(() => setCooling((c) => ({ ...c, [kind]: false })), 3000),
    );
  };

  return (
    <div style={{ ...glassChip(), gap: 3, padding: "0 6px" }} role="group" aria-label="Send a reaction to the presenter">
      {REACTIONS.map((r) => (
        <button
          key={r.kind}
          onClick={() => tap(r.kind)}
          disabled={!!cooling[r.kind]}
          title={r.label}
          aria-label={r.label}
          style={reactionBtn(pulse === r.kind, !!cooling[r.kind])}
        >
          {r.emoji}
        </button>
      ))}
      <button
        onClick={() => tap("lost")}
        disabled={!!cooling.lost}
        title="I'm lost — let the presenter know"
        aria-label="I'm lost"
        style={lostBtn(pulse === "lost", !!cooling.lost)}
      >
        😕 I&rsquo;m lost
      </button>
    </div>
  );
}

function reactionBtn(pulsing: boolean, disabled: boolean): React.CSSProperties {
  return {
    width: 30,
    height: 30,
    borderRadius: 9,
    border: "none",
    background: pulsing ? "rgba(191,224,72,0.55)" : "transparent",
    cursor: disabled ? "default" : "pointer",
    fontSize: 16,
    lineHeight: 1,
    padding: 0,
    opacity: disabled && !pulsing ? 0.4 : 1,
    transform: pulsing ? "scale(1.28)" : "scale(1)",
    transition: "transform .18s ease, background .18s ease, opacity .18s ease",
  };
}

function lostBtn(pulsing: boolean, disabled: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    height: 26,
    padding: "0 10px",
    borderRadius: 8,
    border: "1px solid rgba(210,120,40,0.5)",
    background: pulsing ? "#E07B39" : "rgba(224,123,57,0.16)",
    color: pulsing ? "#fff" : "#9A4B12",
    fontFamily: '"Outfit", system-ui, sans-serif',
    fontSize: 12,
    fontWeight: 600,
    cursor: disabled ? "default" : "pointer",
    opacity: disabled && !pulsing ? 0.55 : 1,
    transform: pulsing ? "scale(1.06)" : "scale(1)",
    transition: "transform .18s ease, background .18s ease, opacity .18s ease",
    whiteSpace: "nowrap",
  };
}
