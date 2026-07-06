# Slide System Rules — for the AI coding agent

Paste this into your AI coding tool (Cursor `.cursorrules`, `AGENTS.md`, or a system prompt). These are the **non-negotiable rules** any agent must follow when building or extending this presentation app and its decks.

**Reference stack:** React + Next.js (App Router) on Vercel. One framework only — never mix React and Vue. You may swap the framework, but every rule below still applies.

**Reference implementation:** [Slidev](https://github.com/slidevjs/slidev) is **MIT-licensed**. Read its source for the hard parts — navigation, scale-to-fit, presenter mode, cross-tab sync. Use it as a reference, **not** a dependency. See the Appendix for what to study and the licensing rule.

---

## 0. Golden rules (read first)

1. **One framework.** No mixing React + Vue. No second slide library.
2. **A slide is one screen.** Fixed 16:9, scales to fit, **never scrolls, never crops.**
3. **It must behave like a deck, not a webpage:** arrow-key navigation, URL tracks the slide, no page reloads.
4. **Slide text is real text in the DOM** — never an image of text. (Needed for the AI sidebar, accessibility, and students copying text.)
5. **Never store a user's prompt or the AI's answer.** Only counts.
6. **The app holds many decks, not one.** A home page lists them; every deck has a permanent URL you can return to.

If a request conflicts with these, follow the rule and flag the conflict.

---

## 1. The deck library & slide model

**The app hosts many decks, not one** — it's a permanent home for all your presentations. You add new decks over time and come back to old ones; nothing is single-use.

- A **deck** = a stable `slug` (permanent, URL-safe), a `title`, a `date`, and an ordered array of **slides**.
- A **slide** has a stable `id`, its `content`, and `notes` (speaker notes — data, not rendered in the main view). Author slides as self-contained components/objects of one canonical shape; don't invent a new structure per slide.
- Speaker notes live in the slide data so the presenter view can read them; they never appear in the main/projector view.
- **One registry is the source of truth** for which decks exist (a manifest file or convention-based folder routing). Adding a deck is one well-defined step.

**Home / library page (`/`):**

- Lists **every deck** as a card showing title, date, and slide count; newest first; searchable once the list grows.
- Clicking a card opens that deck.
- Each deck has its **own permanent URL** (`/d/<slug>`) — bookmark it and return any term. Its presenter view is `/d/<slug>/presenter`; a deep link to a slide is `/d/<slug>#/<n>`.

**Persistence:** decks are defined in the project and **saved by deploying** (git push → Vercel) — consistent with authoring outside the app. There is no in-app *Save* button; *save* = commit + deploy. A deck you deployed last term still works at its URL next term.

---

## 2. Make it *look* like slides (visual rules)

- **Fixed design canvas** of 1280×720 (16:9). Lay everything out against these units, then **scale the whole canvas with a CSS transform to fit the viewport**, centered, letterboxed. Do **not** let content reflow like a normal responsive page.
- **Safe margins:** ≥6% padding on all sides. Nothing touches the edges.
- **One idea per slide.** Hard cap density: ≤6 bullets and ≤~40 words per slide. If it overflows, it's two slides.
- **Typography as tokens.** Define title / heading / body sizes once. Body text must be readable from the back of a room (think ≥24px in design units, scaled up).
- **Theme tokens in one place** (colors, fonts, spacing). No per-slide hardcoded colors or fonts.
- **High contrast.** Assume a washed-out projector — avoid light-grey-on-white and thin fonts.
- **Media stays inside the safe area.** Images/diagrams scale to fit; never overflow the canvas.

---

## 3. Navigation & behavior (REQUIRED)

- **Arrow keys:** `→`, `↓`, `Space`, `PageDown` = **next**. `←`, `↑`, `PageUp` = **previous**.
- `Home` = first slide, `End` = last slide.
- **Stop at the ends** (do not loop) unless told otherwise.
- **URL reflects the current deck and slide** (e.g. `/d/<slug>#/12`). Refresh keeps your place; it's a bookmarkable deep link.
- **No full-page reload between slides** — client-side transition only, no white flash.
- **Touch:** tap right third = next, left third = previous; support swipe.
- **Focus trap:** when the cursor is in the AI sidebar input (or any text field), arrow keys edit text and must **NOT** change slides. This is mandatory.

---

## 4. Fullscreen (Chrome)

- `F` toggles fullscreen via the Fullscreen API. Provide a visible button too, not just the hotkey.
- Fullscreen applies to the **main slide view only**, not the presenter view.

---

## 5. Presenter view (you must build this — there's no framework giving it free)

- Separate route, per deck: `/d/<slug>/presenter`.
- Shows, for the current position: the **current slide**, the **next slide**, the current slide's **speaker notes**, and a **timer** (elapsed time, with start / pause / reset).
- **Cross-tab sync, no server:** the main view and presenter view share the current-slide index via **`BroadcastChannel`** (fallback: `localStorage` `storage` events). Advancing in either view advances both. This must work for two tabs/windows in the **same browser on one laptop** (the projector-as-second-display setup).
- The presenter view is for the presenter only; never link students to it.

---

## 6. Devices & responsiveness

- Must render correctly on **student phones and laptops**: the 16:9 canvas scales down, text stays legible, **no horizontal scroll.**
- Respect `prefers-reduced-motion`: reduce or disable transitions when the user has it set.

---

## 7. Animation

- **One transition style** between slides, fast (≤300ms). Consistent across the whole deck.
- Per-element reveals (click to reveal the next bullet before advancing) are allowed. They consume a "next" press first, then the next press changes slides.
- Animation must **never block navigation** or delay content from being readable.
- Honor `prefers-reduced-motion`.

**Approved effects toolkit** (reach for these before any heavy 3D engine):

- **Transitions & motion:** GSAP (timelines; *Flip* for layout morphs, *SplitText* for text reveals — fully free since 2025) and/or the native **View Transitions API** (best in Chrome — the target). Use **Framer Motion** for React component-level transitions.
- **Particles:** **tsParticles** (fields, constellations, confetti) or **canvas-confetti** for bursts.
- **2D GPU shaders/effects:** **PixiJS**, or **OGL** / **regl** for custom GLSL — only when CSS/GSAP genuinely can't do it.
- **Shader backgrounds:** **Vanta.js** or **shadergradient** as a drop-in background layer.
- **Designed motion graphics:** **Lottie** (After Effects JSON) or **Rive** (interactive vector).
- **Real 3D content:** **Three.js** via **react-three-fiber** — only when the teaching content is genuinely 3D (molecules, anatomy, geometry, rotatable models).

**Hard constraint — effects never touch the text layer:**

- All slide **text stays real DOM** (Rules 0.4 and 8). Any canvas/WebGL effect (Three.js, PixiJS, Vanta, shaders) is a **background layer behind the DOM** or an **embedded island** on the slide — it must **never** render the slide's text, headings, or bullets. This keeps text selectable, accessible, and readable by the AI sidebar even on the flashiest slide.

**Performance & restraint:**

- Default to DOM/CSS/GSAP. Only add a WebGL library (PixiJS, Three.js, Vanta) on the specific slides that use it, and **lazy-load it per slide** — never ship it in the global bundle.
- Stop render loops when the slide isn't visible or the tab is hidden; respect `prefers-reduced-motion`.
- Effects serve the content. If an animation makes text harder to read or delays it, cut it.

---

## 8. Content & accessibility (this is also what powers the AI sidebar)

- **All slide text is selectable, real DOM text.** Never bake text into an image or `<canvas>`.
- Expose a way to read the **current slide's text + notes** programmatically (a selector or function), so the sidebar can pass it to the model as grounding.
- Every image has alt text. Every interactive control is keyboard-reachable with a visible focus state.

---

## 9. AI sidebar (carries over earlier decisions)

- On first load, prompt the student for a **display name**; store it in the browser and send it with every AI request.
- The sidebar calls a **serverless function** — never the model API directly. The function holds the **OpenRouter** key (server-side only; never shipped to the browser).
- **Grounding (v1):** pass the current deck's slide text + notes as context. System instruction: *"Answer only from the provided material. If it isn't there, say you don't know."*
- **Privacy:** persist **only** `{ name, timestamp, token_count }` to the KV store. **Never** log or store the prompt or the answer — not in the DB, not in console/error logs, not in analytics.
- Use an OpenRouter key with a **hard spend cap**; rate-limit per name.

---

## 10. Tech & deployment

- One framework (reference: React + Next.js App Router). Deploy on **Vercel**.
- AI endpoint = a Vercel serverless function in the same project.
- Token counts = **Vercel KV / Upstash Redis** (increment per name).
- All secrets stay server-side.

---

## 11. Definition of done (acceptance checklist — test every item)

- [ ] `←` / `→` change slides; `Space`, `PageUp/Down`, `Home`, `End` all work.
- [ ] URL updates per slide; refresh keeps position; a deep link opens the right slide.
- [ ] No reload or white flash between slides.
- [ ] Every slide fits one screen at 16:9 on a 1080p projector **and** on a phone — no scrolling, no cropping.
- [ ] `F` toggles fullscreen in Chrome on the main view.
- [ ] `/presenter` shows current slide, next slide, speaker notes, and a working timer.
- [ ] Advancing in one tab advances the other (same browser, no server).
- [ ] Slide text is selectable (confirm by highlighting it).
- [ ] Typing in the sidebar input does **not** move slides.
- [ ] No prompt or answer text is written anywhere; only token counts in KV.
- [ ] The home page (`/`) lists every deck (title + date); clicking one opens it.
- [ ] Each deck has a permanent URL (`/d/<slug>`) that still works when you return later.
- [ ] Adding a new deck is one defined step (registry/manifest or folder convention).
- [ ] No slide text is rendered inside a canvas/WebGL layer — effects are background or islands only.
- [ ] Heavy effect libraries (PixiJS / Three.js / Vanta) are lazy-loaded per slide, not in the global bundle.

---

## Appendix: study Slidev (MIT-licensed) for the hard parts

[Slidev](https://github.com/slidevjs/slidev) already solves the exact mechanics you're rebuilding. It is **MIT-licensed** (Copyright © 2020–present Anthony Fu), which means:

- **Reading it for patterns** carries no obligation — do this freely.
- **Copying or adapting a substantial portion of its code** is also allowed, *provided you keep the MIT copyright + permission notice* in your source where that code lives.
- It is **not** a dependency here. We left Slidev to control the look — borrow the mechanics, then write your own components.

Study these subsystems specifically:

- **Keyboard & navigation** — how it maps `←` `→` / `Space` / `PageUp`/`PageDown` to next/prev, and how the current slide is written into the URL.
- **Scale-to-fit canvas** — how it renders a fixed-aspect slide and scales it to any viewport with no reflow. This is the core "looks like slides" trick (Rule 2).
- **Presenter mode** — the `/presenter` layout (current slide + next slide + notes + clock/timer) and how it keeps navigation in sync with the main view across tabs (Rule 5).
- **Click reveals** — how per-element `v-click` reveals consume a "next" press before advancing the slide (Rule 7).
- **Speaker notes** — how a note is attached to a slide and shown only in the presenter view.
