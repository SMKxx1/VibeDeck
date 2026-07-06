"use client";

// The heart of the slide engine. Owns the current position as { index, step }
// and keeps three things in sync with no server (slide-system-rules.md §§3, 5):
//   1. React state   — what renders
//   2. the URL hash  — #/<n>, so refresh keeps your place and deep links work
//   3. a BroadcastChannel — so the presenter view and main view move together
//
// "step" drives click-reveal: a "next" press first advances the step until the
// slide is fully revealed, then moves to the next slide (slide-system-rules.md §7).

import { useCallback, useEffect, useRef, useState } from "react";
import type { Deck } from "./types";
import { maxStep } from "./deckUtils";
import { createSyncChannel, type SyncChannel } from "./sync";

export interface NavState {
  index: number;
  step: number;
}

export interface SlideNav extends NavState {
  count: number;
  next: () => void;
  prev: () => void;
  goto: (index: number, step?: number) => void;
  first: () => void;
  last: () => void;
  atStart: boolean;
  atEnd: boolean;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function parseHash(count: number): number | null {
  if (typeof window === "undefined") return null;
  const m = window.location.hash.match(/^#\/(\d+)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (Number.isNaN(n)) return null;
  return clamp(n - 1, 0, count - 1);
}

function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

export function useSlideNav(deck: Deck, opts?: { syncHash?: boolean }): SlideNav {
  const syncHash = opts?.syncHash ?? true;
  const count = deck.slides.length;

  const [state, setState] = useState<NavState>({ index: 0, step: 0 });
  const stateRef = useRef(state);
  stateRef.current = state;

  const channelRef = useRef<SyncChannel | null>(null);

  // Write the current slide into the URL hash. replaceState is intentional: it
  // updates the URL silently (no hashchange echo, no 50-entry history trail)
  // while still surviving refresh and producing a bookmarkable deep link.
  const writeHash = useCallback(
    (index: number) => {
      if (!syncHash || typeof window === "undefined") return;
      const next = `#/${index + 1}`;
      if (window.location.hash !== next) {
        window.history.replaceState(null, "", next);
      }
    },
    [syncHash],
  );

  // The one place state changes. `broadcast` tells peers; we set it false when
  // the change *came from* a peer so we don't echo back into a loop.
  const apply = useCallback(
    (nextIndex: number, nextStep: number, broadcast: boolean) => {
      const idx = clamp(nextIndex, 0, count - 1);
      const st = clamp(nextStep, 0, maxStep(deck.slides[idx]));
      setState({ index: idx, step: st });
      writeHash(idx);
      if (broadcast && channelRef.current) {
        channelRef.current.post({ type: "state", index: idx, step: st });
      }
    },
    [count, deck.slides, writeHash],
  );

  const next = useCallback(() => {
    const { index, step } = stateRef.current;
    if (step < maxStep(deck.slides[index])) apply(index, step + 1, true);
    else if (index < count - 1) apply(index + 1, 0, true);
    // else: at the very end — stop, do not loop (slide-system-rules.md §3)
  }, [apply, count, deck.slides]);

  const prev = useCallback(() => {
    const { index, step } = stateRef.current;
    if (step > 0) apply(index, step - 1, true);
    // Going back lands on the previous slide fully revealed, ready to re-explain.
    else if (index > 0) apply(index - 1, maxStep(deck.slides[index - 1]), true);
  }, [apply, deck.slides]);

  const goto = useCallback((index: number, step = 0) => apply(index, step, true), [apply]);
  const first = useCallback(() => apply(0, 0, true), [apply]);
  const last = useCallback(() => apply(count - 1, 0, true), [apply, count]);

  // Channel + deep-link initialization + peer handshake.
  useEffect(() => {
    const ch = createSyncChannel(deck.slug, (msg) => {
      if (msg.type === "request") {
        const { index, step } = stateRef.current;
        ch.post({ type: "state", index, step });
      } else if (msg.type === "state" && typeof msg.index === "number") {
        apply(msg.index, msg.step ?? 0, false);
      }
    });
    channelRef.current = ch;

    const fromHash = parseHash(count);
    if (fromHash !== null) {
      // We loaded with an explicit position (deep link / refresh). Keep it and
      // do NOT ask peers — an asymmetric handshake. If we requested, a peer's
      // reply (its own position) could race in and overwrite ours.
      apply(fromHash, 0, false);
    } else {
      // No position of our own — join the live session by asking any peer
      // (e.g. a main view already presenting) where we are.
      ch.post({ type: "request" });
    }

    return () => {
      ch.close();
      channelRef.current = null;
    };
    // deck.slug + count are stable for the deck's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck.slug, count]);

  // Manual URL edits (typing a new #/<n>) should move every synced view.
  useEffect(() => {
    if (!syncHash) return;
    const onHash = () => {
      const idx = parseHash(count);
      if (idx !== null && idx !== stateRef.current.index) apply(idx, 0, true);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [count, apply, syncHash]);

  // Keyboard navigation — with the mandatory focus trap (slide-system-rules.md §3).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return; // leave browser shortcuts alone
      if (isEditableTarget(e.target) || isEditableTarget(document.activeElement)) return;
      switch (e.key) {
        case "ArrowRight":
        case "ArrowDown":
        case "PageDown":
        case " ":
          e.preventDefault();
          next();
          break;
        case "ArrowLeft":
        case "ArrowUp":
        case "PageUp":
          e.preventDefault();
          prev();
          break;
        case "Home":
          e.preventDefault();
          first();
          break;
        case "End":
          e.preventDefault();
          last();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, prev, first, last]);

  const atStart = state.index === 0 && state.step === 0;
  const atEnd =
    state.index === count - 1 && state.step === maxStep(deck.slides[count - 1]);

  return {
    ...state,
    count,
    next,
    prev,
    goto,
    first,
    last,
    atStart,
    atEnd,
  };
}
