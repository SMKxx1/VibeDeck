# Class Presentation App

A web-native replacement for PowerPoint: a **library of slide decks** you present
from in class (projector + a separate presenter view on your laptop), with an **AI
sidebar** students can ask questions — grounded in the slides themselves.

Built as a **custom slide system** (Next.js App Router + React, plain CSS design
tokens) to the rules in [`Guideline/slide-system-rules.md`](./Guideline/slide-system-rules.md)
and the plan in [`Guideline/presentation-webapp-plan.md`](./Guideline/presentation-webapp-plan.md).
No Slidev, no second framework, no heavy animation libraries in the bundle.

---

## What it does

| | |
|---|---|
| **Library home** (`/`) | Lists every deck (title · date · slide count), newest first, searchable. |
| **Main view** (`/d/<slug>`) | The projector view. Scale-to-fit 16:9 canvas, arrow-key nav, `F` fullscreen, AI sidebar, touch nav. |
| **Presenter view** (`/d/<slug>/presenter`) | Your laptop view: current slide, next slide, speaker notes, and a start/pause/reset timer. |
| **Cross-tab sync** | Main ↔ presenter stay in lock-step via `BroadcastChannel` — same browser, **no server**. |
| **AI sidebar** | Calls a serverless function → OpenRouter, grounded in the deck. Stores only token counts, never prompts. |

Deep links work: `/d/<slug>#/<n>` opens slide `n`; refresh keeps your place.

---

## Quick start

```bash
npm install
npm run dev        # http://localhost:3000
```

Build & run the production server:

```bash
npm run build
npm start
```

The slides work with **zero configuration**. The AI sidebar is optional — without
an OpenRouter key it simply reports that AI isn't configured; everything else works.

---

## Environment variables

Copy [`.env.example`](./.env.example) to `.env.local` and fill in what you need.
All of these are **server-side only** — none are exposed to the browser.

| Variable | Required | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | for AI | OpenRouter key. **Use a key with a hard spend cap.** |
| `OPENROUTER_MODEL` | no | Model id (default `openai/gpt-4o-mini`). |
| `OPENROUTER_SITE_URL` / `OPENROUTER_SITE_NAME` | no | Sent to OpenRouter for analytics. |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | no | Token-count store + rate limiting. If unset, tracking is skipped. |
| `AI_RATE_LIMIT_MAX` / `AI_RATE_LIMIT_WINDOW_SECONDS` | no | Per-name rate limit (default 20 / 60s). |
| `AI_CLASS_PASSWORD` | no | Shared password gate for the AI endpoint (the "public link = open wallet" guard). |

> **Privacy:** the serverless function persists **only** `{ name, timestamp, token_count }`.
> It never logs or stores the prompt or the answer — not in the KV store, not in
> console/error logs. To keep prompts private *upstream too*, set OpenRouter's data
> policy to no-logging / non-retaining providers.

---

## Deploy to Vercel

1. Push this repo to GitHub.
2. Import it in Vercel (it auto-detects Next.js — no config needed).
3. Add the env vars above in **Project → Settings → Environment Variables**.
4. Deploy. Each deck lives permanently at `/d/<slug>`.

"Saving" a deck = commit + deploy. A deck you deployed last term still works at its
URL next term.

### Dual-screen workflow (the standard case)

One laptop drives two displays. Open the **main view**, drag it to the projector
(extended display), and press `F` to fullscreen it. Open the **presenter view** in a
second tab on your laptop screen. They sync through the same browser — clicking
forward in either advances both. No sync server required.

---

## Add a deck (one step)

1. Create `lib/decks/<your-deck>.ts` that exports a `Deck` (copy an existing one):

   ```ts
   import type { Deck } from "../types";

   export const myDeck: Deck = {
     slug: "my-deck",            // permanent, URL-safe
     title: "My Lecture",
     date: "2026-09-01",
     description: "One-line summary for the library card.",
     slides: [
       { id: "cover", layout: "title", title: "My Lecture",
         subtitle: "Week 1", notes: "Say hello." },
       { id: "points", layout: "bullets", title: "Today",
         bullets: ["First", "Second"], reveal: true,
         notes: "Reveal one at a time." },
     ],
   };
   ```

2. Register it in [`lib/decks/index.ts`](./lib/decks/index.ts):

   ```ts
   import { myDeck } from "./my-deck";
   export const decks: Deck[] = [awsLodgeDemo, slideSystemTour, myDeck];
   ```

3. Commit + deploy. It appears on the home page and lives at `/d/my-deck`.

### Slide layouts

One canonical shape, picked by `layout`: `title` · `section` · `statement` ·
`bullets` · `two-col` · `quote` · `image`. Keep it to **one idea per slide**
(≤6 bullets, ≤~40 words). Set `reveal: true` to reveal bullets/columns one click at
a time. Put speaker notes in `notes` — they show only in the presenter view.
All `image` slides require `alt` text.

> **Animation:** the deck ships with one fast slide transition and CSS click-reveals
> only. Heavier effects (GSAP, tsParticles, PixiJS, Vanta, Three.js) are allowed per
> the rules but must be **lazy-loaded per slide as background layers / islands** —
> never imported into the global bundle and never used to render slide text.

---

## Keyboard

| Key | Action |
|---|---|
| `→` `↓` `Space` `PageDown` | Next (reveals the next bullet first, then advances) |
| `←` `↑` `PageUp` | Previous |
| `Home` / `End` | First / last slide |
| `F` | Toggle fullscreen (main view) |
| `S` | Toggle the AI sidebar · `Esc` closes it |

Typing in the sidebar (or any text field) never moves the slides.

---

## Project structure

```
app/
  layout.tsx              root layout + theme
  globals.css             THE design tokens + slide layouts (one place)
  page.tsx                library home
  d/[slug]/page.tsx       main view
  d/[slug]/presenter/     presenter view
  api/ask/route.ts        AI serverless function (holds the key)
components/                SlideView, SlideStage, DeckViewer, PresenterView, Sidebar, …
lib/
  types.ts                Deck / Slide model
  decks/                  the deck registry (source of truth) + deck files
  useSlideNav.ts          navigation: state ⇄ URL hash ⇄ BroadcastChannel
  useScaleToFit.ts        the 1280×720 scale-to-fit canvas
  kv.ts                   token tracking + rate limiting (server-only)
public/
  diagram-architecture.svg
```

---

## Not in scope (yet)

- **RAG over course materials** — slides-only grounding until usage proves it out.
- **PPTX importer** — a content-extractor script, built last if ever.
- **Separate-computer projector sync** — only needed if a *different* machine runs
  the projector; the same-laptop setup needs no server.
