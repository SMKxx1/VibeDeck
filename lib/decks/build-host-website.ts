import type { Deck } from "../types";

// "Build & Host Your Own Website" — the AI Lodge live workshop deck, imported
// pixel-for-pixel from the Claude Design handoff (Main Slide.dc.html).
//
// Unlike the hand-authored decks, this one ships as a self-contained HTML deck:
// its own <deck-stage> engine + the design's exact markup + vendored React, all
// served statically from public/decks/build-host-website/. The app renders it
// full-bleed in an iframe (see components/EmbeddedDeck), so it looks and behaves
// EXACTLY like the design — live café HTML/CSS/JS demo, login flow, draggable
// laptop stickers, interactive build pipeline, and live pinboard included.
export const buildHostWebsite: Deck = {
  slug: "build-host-website",
  title: "Build & Host Your Own Website",
  date: "2026-07-05",
  description:
    "A beginner-friendly live workshop — create and publish your first live website in ~90 minutes, no code required.",
  embedUrl: "/decks/build-host-website/index.html",
  slideCount: 13,
  slides: [],
};
