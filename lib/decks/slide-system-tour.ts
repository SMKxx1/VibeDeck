import type { Deck } from "../types";

// A short, functional manual that doubles as an acceptance demo: it tells you
// exactly which keys and features to test against the Definition of Done.

export const slideSystemTour: Deck = {
  slug: "slide-system-tour",
  title: "How This Deck Works",
  date: "2026-06-29",
  description: "A 6-slide tour of navigation, fullscreen, the presenter view, and the AI sidebar.",
  slides: [
    {
      id: "cover",
      layout: "title",
      eyebrow: "Manual",
      title: "How This Deck Works",
      subtitle: "Drive it like a deck, not a webpage",
      accent: "violet",
      notes: "Use this deck to sanity-check every behavior before presenting for real.",
    },
    {
      id: "navigate",
      layout: "bullets",
      eyebrow: "Move around",
      title: "Navigate with the keyboard",
      bullets: [
        "→ ↓ Space PageDown — next",
        "← ↑ PageUp — previous",
        "Home / End — first / last slide",
        "The URL tracks the slide; refresh keeps your place",
      ],
      notes: "Try refreshing on slide 3 — it should come back to slide 3.",
    },
    {
      id: "reveal",
      layout: "bullets",
      eyebrow: "Build a point",
      title: "Bullets can reveal on click",
      reveal: true,
      bullets: [
        "Press next — this appears first",
        "Press again — then this",
        "A reveal eats one \"next\" before the slide turns",
        "Going back shows the slide fully built",
      ],
      notes: "This is the click-reveal behavior from the rules — steps before advancing.",
    },
    {
      id: "fullscreen-presenter",
      layout: "two-col",
      eyebrow: "Two screens",
      title: "Fullscreen + presenter view",
      columns: [
        {
          heading: "Projector (main)",
          bullets: ["Press F for fullscreen", "Drag to the second display", "Arrow keys advance both"],
        },
        {
          heading: "Laptop (presenter)",
          bullets: ["Open /presenter", "Next slide · notes · timer", "Stays in sync, no server"],
        },
      ],
      accent: "teal",
      notes:
        "Open the presenter view in a second tab and confirm advancing in either tab moves both.",
    },
    {
      id: "sidebar",
      layout: "bullets",
      eyebrow: "Ask the slides",
      title: "The AI sidebar",
      bullets: [
        "Open it with the chat button (or press S)",
        "Set your display name on first use",
        "It answers only from this deck's content",
        "Typing in the box never moves the slides",
      ],
      notes:
        "Test the focus trap: click into the input and press the arrow keys — the slide must not change.",
    },
    {
      id: "end",
      layout: "statement",
      eyebrow: "That's it",
      body: "Your move — press → to wrap, or open the sidebar and ask.",
      accent: "amber",
      notes: "End of the tour.",
    },
  ],
};
