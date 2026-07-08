// The MERGED deck registry: compiled in-repo decks (lib/decks/static) plus runtime
// uploaded decks (lib/uploaded-decks). This is the one place the two provenances
// are unified for the app to consume.
//
// Both getters are async because uploaded decks require a DB read. staticDecks is
// pure/synchronous — it's read first so a compiled deck ALWAYS wins a slug
// collision (static precedence): an uploaded row can never shadow a real registry
// deck. Adding a compiled deck stays a code-only step (see lib/decks/static.ts).

import type { Deck } from "../types";
import { staticDecks } from "./static";
import { getUploadedDeck, getUploadedDecks } from "../uploaded-decks";

/** Static precedence: a compiled deck always wins a slug collision. */
export async function getDeck(slug: string): Promise<Deck | undefined> {
  return staticDecks.find((d) => d.slug === slug) ?? (await getUploadedDeck(slug));
}

/** Every deck, newest first — used by the library home page + dashboard. */
export async function listDecks(): Promise<Deck[]> {
  const uploaded = await getUploadedDecks();
  return [...staticDecks, ...uploaded].sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : 0,
  );
}
