"use client";

// The PRESENTER view — your laptop screen (slide-system-rules.md §5).
// Current slide, next slide, the current slide's speaker notes, and a timer.
// Stays in sync with the main view through BroadcastChannel (in useSlideNav),
// and you can drive from here too. Never link students to this route.

import { useEffect, useState } from "react";
import type { Deck } from "@/lib/types";
import { useSlideNav } from "@/lib/useSlideNav";
import { maxStep } from "@/lib/deckUtils";
import { SlideStage } from "./SlideStage";
import { SlideView } from "./SlideView";
import { Timer } from "./Timer";
import styles from "./PresenterView.module.css";

export function PresenterView({ deck }: { deck: Deck }) {
  const nav = useSlideNav(deck);
  const [clock, setClock] = useState("");

  useEffect(() => {
    const tick = () =>
      setClock(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    tick();
    const id = window.setInterval(tick, 15_000);
    return () => window.clearInterval(id);
  }, []);

  const current = deck.slides[nav.index];
  const next = deck.slides[nav.index + 1];
  const ms = maxStep(current);

  return (
    <div className={styles.root}>
      <header className={styles.topbar}>
        <span className={styles.deckTitle}>{deck.title}</span>
        <span className={styles.tag}>Presenter</span>
        <span className={styles.clock}>{clock}</span>
      </header>

      <div className={styles.main}>
        <section className={styles.currentWrap}>
          <div className={styles.label}>
            Current · {nav.index + 1}/{nav.count}
            {ms > 0 ? ` · step ${nav.step + 1}/${ms + 1}` : ""}
          </div>
          <div className={styles.currentStage}>
            <SlideStage>
              <SlideView key={nav.index} slide={current} step={nav.step} />
            </SlideStage>
          </div>
        </section>

        <aside className={styles.side}>
          <div className={styles.nextBlock}>
            <div className={styles.label}>Next</div>
            <div className={styles.nextStage}>
              {next ? (
                <SlideStage>
                  <SlideView slide={next} step={maxStep(next)} revealAll />
                </SlideStage>
              ) : (
                <div className={styles.endCard}>End of deck</div>
              )}
            </div>
          </div>

          <div className={styles.notesBlock}>
            <div className={styles.label}>Notes</div>
            <div className={styles.notes}>
              {current.notes ? (
                current.notes
              ) : (
                <span className={styles.noNotes}>No notes for this slide.</span>
              )}
            </div>
          </div>
        </aside>
      </div>

      <footer className={styles.footer}>
        <div className={styles.navBtns}>
          <button type="button" onClick={nav.prev} disabled={nav.atStart}>
            ‹ Prev
          </button>
          <button type="button" onClick={nav.next} disabled={nav.atEnd}>
            Next ›
          </button>
        </div>
        <Timer />
        <a className={styles.mainLink} href={`/d/${deck.slug}`} target="_blank" rel="noreferrer">
          Open main view ↗
        </a>
      </footer>
    </div>
  );
}
