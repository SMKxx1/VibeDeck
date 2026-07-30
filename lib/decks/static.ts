// The compiled, in-repo deck registry — re-exported from the content seam
// (lib/decks/content.ts), which is the single file that differs between the
// private (bundled workshop deck) and public (no bundled content) builds.
//
// Split out of lib/decks/index.ts so the DB boot sequence (lib/schema.ts) can
// seed a top-level row for each static deck WITHOUT importing the merged async
// registry — that import would drag the uploaded-deck DB reads into the seeding
// path and form a cycle.

export { staticDecks } from "./content";
