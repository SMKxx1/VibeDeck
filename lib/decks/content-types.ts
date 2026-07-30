// Shared shapes for BUNDLED deck content (lib/decks/content.ts). These types
// are platform code — they compile identically whether the build carries real
// bundled content (the private repo) or none (the public repo).

/** One slide's AI-grounding entry for a bundled embed deck. */
export interface SlideContext {
  index: number;
  label: string;
  text: string;
}

export interface SeedSlide {
  index: number;
  label: string;
  speakerNotes: string;
  aiContext: string;
}

/** A bundled deck's initial DB seed: top-level row + per-slide notes/context. */
export interface DeckSeed {
  slug: string;
  title: string;
  date: string;
  description: string;
  embedUrl: string;
  slideCount: number;
  slides: SeedSlide[];
}
