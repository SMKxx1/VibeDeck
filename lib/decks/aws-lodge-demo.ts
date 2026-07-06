import type { Deck } from "../types";

// Demo-day pitch for the app itself. Doubles as a coverage test: it exercises
// every slide layout (title, statement, bullets, two-col, section, image,
// quote) plus click-reveal and speaker notes.

export const awsLodgeDemo: Deck = {
  slug: "aws-lodge-demo",
  title: "The Deck That Answers Back",
  date: "2026-06-30",
  description:
    "Demo Day pitch — a web-native replacement for PowerPoint with an AI tutor built into every slide.",
  slides: [
    {
      id: "cover",
      layout: "title",
      eyebrow: "AWS Lodge · Demo Day",
      title: "The Deck That Answers Back",
      subtitle: "A web-native replacement for PowerPoint — with an AI tutor on every slide",
      accent: "amber",
      notes:
        "Open here. One line: this is a slide deck students can ask questions to, grounded in the slides themselves. Set your name first so the demo shows the join flow.",
    },
    {
      id: "thesis",
      layout: "statement",
      body: "Slides should keep teaching after the room empties.",
      accent: "teal",
      notes:
        "The core thesis. A slide is usually a dead artifact once class ends. We make it answer questions instead.",
    },
    {
      id: "problem",
      layout: "bullets",
      eyebrow: "The problem",
      title: "PowerPoint stops at the slide",
      reveal: true,
      bullets: [
        "A student who's lost has to wait, email, or guess",
        "The deck can't explain itself — it's just an image of text",
        "You re-answer the same five questions every term",
        "Nothing the class asks ever feeds back to you",
      ],
      notes:
        "Click through one at a time. Land on the last point — the lost feedback loop is what the sidebar fixes.",
    },
    {
      id: "before-after",
      layout: "two-col",
      eyebrow: "The shift",
      title: "Same deck, two jobs",
      columns: [
        {
          heading: "PowerPoint",
          bullets: ["Present once", "Static after class", "Questions wait for you", "Lives on a USB stick"],
        },
        {
          heading: "This app",
          bullets: ["A permanent library", "Answers 24/7 from the slides", "Asks you nothing it can invent", "Lives at a URL"],
        },
      ],
      accent: "violet",
      notes: "Contrast, not a feature list. The right column is the pitch.",
    },
    {
      id: "how-section",
      layout: "section",
      eyebrow: "Under the hood",
      title: "How it works",
      accent: "teal",
      notes: "Transition into architecture. Keep it to 30 seconds.",
    },
    {
      id: "architecture",
      layout: "image",
      title: "One browser, no sync server",
      image: {
        inline: "architecture",
        alt: "Architecture: the author deploys a slide app to Vercel. The app serves a main projector view, a presenter view with notes and a timer, and an AI sidebar. The sidebar calls a serverless function that talks to OpenRouter and stores only token counts in a KV store. The main and presenter views sync through the same browser with no server.",
        caption: "Main + presenter sync over BroadcastChannel · the AI key never leaves the server",
      },
      notes:
        "Two points only: (1) presenter sync is free because your laptop drives the projector as a second display; (2) the OpenRouter key lives server-side and we store token counts, never prompts.",
    },
    {
      id: "students",
      layout: "bullets",
      eyebrow: "For students",
      title: "Open a link, ask anything",
      bullets: [
        "Set a display name once — no account",
        "Page through the slides on their own phone",
        "Ask the sidebar; it answers from the slides or says \"I don't know\"",
        "Their questions stay private — we store counts, not text",
      ],
      notes:
        "Emphasize the grounding promise: the AI won't make things up, it's pinned to your material.",
    },
    {
      id: "teachers",
      layout: "bullets",
      eyebrow: "For you",
      title: "A presenter cockpit, not a clicker",
      reveal: true,
      bullets: [
        "Next slide, speaker notes, and a timer on your laptop",
        "Projector goes fullscreen with one key",
        "Every deck you've ever made, at a permanent URL",
        "A per-name view of who's actually using the tutor",
      ],
      notes:
        "Reveal one by one. The timer + notes + next-slide combo is what replaces a paper script.",
    },
    {
      id: "quote",
      layout: "quote",
      quote: "The best teaching tool is the one that's still in the room after you leave.",
      attribution: "the design brief, basically",
      accent: "amber",
      notes: "Breather slide. Optional — skip if running long.",
    },
    {
      id: "cta",
      layout: "statement",
      eyebrow: "Try it now",
      body: "Open the link. Set your name. Ask the slides anything.",
      accent: "teal",
      notes:
        "Close by actually doing it live: open the sidebar, ask a question about an earlier slide, show it answering from the deck.",
    },
  ],
};
