// THE CONTENT SEAM — public variant. The private content build replaces this
// file (and adds the modules + public/decks/ assets it imports) to bundle a
// built-in workshop deck; this public repo ships no bundled content. Same
// export surface in both variants — every platform feature works either way,
// presenters simply upload their own decks.

import type { Deck } from "../types";
import type { DeckSeed, SlideContext } from "./content-types";

/** Decks compiled into the bundle (none in the public build). */
export const staticDecks: Deck[] = [];

/** Per-slide grounding + notes seeded into the DB on first boot (none). */
export const contentSeeds: DeckSeed[] = [];

/** Static AI-grounding fallback for a bundled embed deck (none — DB only). */
export const embedContext: SlideContext[] = [];

export function contextForSlide(index: number): SlideContext | undefined {
  void index;
  return undefined;
}

export function fullContextText(): string {
  return "";
}
