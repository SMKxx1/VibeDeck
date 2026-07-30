// THE CONTENT SEAM. This file — plus the modules and public/decks/ assets it
// pulls in — is the ONLY difference between the private build and the public
// repo. The private version (this one) bundles the WSS-Lodge workshop deck;
// the public repo ships the empty variant of this file (same export surface,
// zero content) and every platform feature still works — presenters simply
// upload their own decks. Keep the export NAMES stable in both variants.

import type { Deck } from "../types";
import type { DeckSeed } from "./content-types";
import { buildHostWebsite } from "./build-host-website";
import { buildHostWebsiteSeed } from "./build-host-website-seed";

/** Decks compiled into the bundle (served without any DB). */
export const staticDecks: Deck[] = [buildHostWebsite];

/** Per-slide grounding + notes seeded into the DB on first boot. */
export const contentSeeds: DeckSeed[] = [buildHostWebsiteSeed];

/** Static AI-grounding fallback for the bundled embed deck (DB-first at runtime). */
export {
  buildHostWebsiteContext as embedContext,
  contextForSlide,
  fullContextText,
} from "./build-host-website-context";
