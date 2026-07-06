"use client";

// The MAIN view — what the projector shows (slide-system-rules.md §§3, 4, 9).
// Slides, on-screen controls, fullscreen (F), the AI sidebar (S), touch nav,
// and the first-load name prompt. Navigation/sync lives in useSlideNav.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Deck } from "@/lib/types";
import { useSlideNav } from "@/lib/useSlideNav";
import { useFullscreen } from "@/lib/useFullscreen";
import { SlideStage } from "./SlideStage";
import { SlideView } from "./SlideView";
import { Sidebar } from "./Sidebar";
import { NameGate } from "./NameGate";
import styles from "./DeckViewer.module.css";

const NAME_KEY = "presentation:name";

function isEditable(el: Element | null): boolean {
  return (
    el instanceof HTMLElement &&
    (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
  );
}

export function DeckViewer({ deck }: { deck: Deck }) {
  const nav = useSlideNav(deck);
  const { isFullscreen, toggle } = useFullscreen();
  const rootRef = useRef<HTMLDivElement>(null);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [showGate, setShowGate] = useState(false);
  const touchStartX = useRef<number | null>(null);

  // Load stored name; prompt on first load if missing (rules §9).
  useEffect(() => {
    const stored = localStorage.getItem(NAME_KEY);
    if (stored) setName(stored);
    else setShowGate(true);
  }, []);

  const saveName = useCallback((n: string) => {
    localStorage.setItem(NAME_KEY, n);
    setName(n);
    setShowGate(false);
  }, []);

  // F = fullscreen, S = sidebar, Esc = close sidebar — never while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditable(document.activeElement)) return;
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        void toggle(rootRef.current);
      } else if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        setSidebarOpen((o) => !o);
      } else if (e.key === "Escape" && sidebarOpen) {
        setSidebarOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, sidebarOpen]);

  // Touch: swipe, or tap right third = next / left third = previous (rules §3).
  const onTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touchStartX.current;
    touchStartX.current = null;
    if (start == null) return;
    const endX = e.changedTouches[0].clientX;
    const dx = endX - start;
    if (Math.abs(dx) > 50) {
      if (dx < 0) nav.next();
      else nav.prev();
      return;
    }
    const w = window.innerWidth;
    if (endX > w * 0.66) nav.next();
    else if (endX < w * 0.34) nav.prev();
  };

  const current = deck.slides[nav.index];

  return (
    <div className={styles.root} ref={rootRef}>
      <div className={styles.body}>
        <div
          className={styles.stageWrap}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
        >
          <SlideStage>
            <SlideView key={nav.index} slide={current} step={nav.step} />
          </SlideStage>
        </div>

        {sidebarOpen && name && (
          <Sidebar
            deck={deck}
            slideIndex={nav.index}
            name={name}
            onClose={() => setSidebarOpen(false)}
            onChangeName={() => setShowGate(true)}
          />
        )}
      </div>

      <div className={styles.controls} role="toolbar" aria-label="Slide controls">
        <button
          type="button"
          onClick={nav.prev}
          disabled={nav.atStart}
          aria-label="Previous slide"
        >
          ‹
        </button>
        <span className={styles.counter} aria-live="polite">
          {nav.index + 1} / {nav.count}
        </span>
        <button
          type="button"
          onClick={nav.next}
          disabled={nav.atEnd}
          aria-label="Next slide"
        >
          ›
        </button>
        <span className={styles.sep} aria-hidden="true" />
        <button
          type="button"
          onClick={() => void toggle(rootRef.current)}
          aria-label="Toggle fullscreen"
          title="Fullscreen (F)"
        >
          {isFullscreen ? "✕⛶" : "⛶"}
        </button>
        <button
          type="button"
          onClick={() => setSidebarOpen((o) => !o)}
          aria-label="Toggle AI assistant"
          aria-pressed={sidebarOpen}
          title="Ask AI (S)"
          className={sidebarOpen ? styles.active : undefined}
        >
          💬
        </button>
      </div>

      <div className={styles.progress} aria-hidden="true">
        <div
          className={styles.progressBar}
          style={{ width: `${((nav.index + 1) / nav.count) * 100}%` }}
        />
      </div>

      {showGate && <NameGate onSubmit={saveName} />}
    </div>
  );
}
