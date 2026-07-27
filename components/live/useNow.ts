"use client";

// Shared live-room ticker hook — the SINGLE implementation used by both LiveDeck
// and UploadedDeckFrame. Extracted verbatim from LiveDeck.

import { useEffect, useState } from "react";

// Re-render every `stepMs` so a client-side countdown ticks. Returns "now".
export function useNow(stepMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), stepMs);
    return () => window.clearInterval(id);
  }, [stepMs]);
  return now;
}
