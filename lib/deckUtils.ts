// Pure text-projection helpers for AI grounding. No browser or Node APIs here
// so both runtimes can import them safely.

import type { Deck, Slide } from "./types";

/**
 * All readable text on a slide, including speaker notes — the grounding the AI
 * sidebar passes to the model (slide-system-rules.md §§8–9). Built from data,
 * never scraped from the DOM, so hidden reveals are still included.
 */
export function slideToText(slide: Slide): string {
  const parts: string[] = [];
  if (slide.eyebrow) parts.push(slide.eyebrow);
  if (slide.title) parts.push(slide.title);
  if (slide.subtitle) parts.push(slide.subtitle);
  if (slide.body) parts.push(slide.body);
  if (slide.bullets) parts.push(...slide.bullets.map((b) => `• ${b}`));
  if (slide.columns) {
    for (const col of slide.columns) {
      if (col.heading) parts.push(col.heading);
      parts.push(...col.bullets.map((b) => `• ${b}`));
    }
  }
  if (slide.quote) parts.push(`"${slide.quote}"`);
  if (slide.attribution) parts.push(`— ${slide.attribution}`);
  if (slide.image?.caption) parts.push(slide.image.caption);
  if (slide.image?.alt) parts.push(`[image: ${slide.image.alt}]`);
  if (slide.notes) parts.push(`Notes: ${slide.notes}`);
  return parts.join("\n");
}

/** The full deck as plain text, slide by slide — used to ground the AI sidebar. */
export function deckToText(deck: Deck): string {
  return deck.slides
    .map((s, i) => `--- Slide ${i + 1} (${s.layout}) ---\n${slideToText(s)}`)
    .join("\n\n");
}
