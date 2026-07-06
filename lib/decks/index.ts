// One registry = the single source of truth for which decks exist
// (slide-system-rules.md §1).
//
// Adding a deck is ONE defined step:
//   1. create lib/decks/<your-deck>.ts that `export`s a Deck
//   2. import it here and add it to the `decks` array below
// Commit + deploy = "saved". The deck then lives forever at /d/<slug>.

import type { Deck } from "../types";
import { awsLodgeDemo } from "./aws-lodge-demo";
import { slideSystemTour } from "./slide-system-tour";
import { buildHostWebsite } from "./build-host-website";

export const decks: Deck[] = [buildHostWebsite, awsLodgeDemo, slideSystemTour];

export function getDeck(slug: string): Deck | undefined {
  return decks.find((d) => d.slug === slug);
}

/** Every deck, newest first — used by the library home page. */
export function listDecks(): Deck[] {
  return [...decks].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}
