// The compiled, in-repo deck registry: decks authored as code and shipped in the
// bundle (slide-system-rules.md §1). Pure and synchronous.
//
// Split out of lib/decks/index.ts so the DB boot sequence (lib/schema.ts) can seed
// a top-level row for each of these WITHOUT importing the merged async registry —
// that import would drag the uploaded-deck DB reads (which themselves need
// ensureSchema) into the seeding path and form a cycle. The static-seeding pass
// must loop THIS array, never the merged registry: uploaded rows own themselves
// and must never be re-touched by static seeding.
//
// Adding a deck stays a one-step change: create lib/decks/<your-deck>.ts, import
// it here, add it to the array. Commit + deploy = "saved", live forever at /d/<slug>.

import type { Deck } from "../types";
import { buildHostWebsite } from "./build-host-website";

export const staticDecks: Deck[] = [buildHostWebsite];
