> **Historical planning document (June 2026) — superseded.** The platform
> shipped far past this plan: accounts + invites + Google sign-in, uploaded
> decks on an isolated origin, Redis live rooms, and a dozen AI features, all
> running on Railway (not Vercel). Kept for context; nothing here is normative.

# Class Presentation Web App — Build Plan

A web-based replacement for PowerPoint, hosted on Vercel, for **your own teaching**: you present from it in class (projector + a separate presenter view on your laptop), students open a link, set a name, and page through the slides with an AI sidebar that answers their questions — grounded first in the slides, later in your course materials. The app is a **library of presentations** you build up over time — not a single deck — so you add new ones and return to past ones.

This plan reflects the decisions made during grilling plus the requirements added in this revision.

---

## What we locked in

| Decision | Choice | Effect |
|---|---|---|
| **Audience** | Just you + your classes | No accounts, no billing, no multi-tenant. |
| **PPTX import** | Content extractor, *not* a fidelity importer | Pull text/images → AI rebuilds. Built last. |
| **AI authoring** | Outside the app (Cursor/Claude → push to Vercel) | App = viewer + presenter view + sidebar. No in-app generator. |
| **AI sidebar scope** | Slides + course materials (RAG) | Staged: slides-only first, retrieval later. |
| **AI provider** | **OpenRouter** | One API/key for many models; usage returned per call; spend-cappable keys. |
| **Viewer identity** | Name on join (self-declared) | Keys per-user token tracking. Not authenticated. |
| **Prompt privacy** | Track tokens, never store prompt text | Deliberate stance — see the sharp edge below. |

The framework is a **custom slide system** (reference: React + Next.js on Vercel — one framework, not React + Vue), governed by `slide-system-rules.md`. Dropping Slidev means the slide viewer, fullscreen, presenter view, speaker notes, timer, and cross-tab sync are now **custom-built to those rules** — more control over the look, more surface area to get right. For animation, the approved stack is **GSAP + the native View Transitions API** (with **tsParticles** / **PixiJS** / **Vanta** for particles and shader backdrops) — all layered behind DOM text, never replacing it. Reach for **Three.js (via react-three-fiber)** only for genuinely 3D teaching content. Details in the rules doc.

---

## Presenter & viewer experience

**A deck library plus two views per deck (all specified in `slide-system-rules.md`):**

- **Library home** (`/`) — lists all your decks; click one to open it. This is how you come back to past presentations.
- **Main view** (`/d/<slug>`) — the slides. Goes **fullscreen in Chrome** (`F` key via the Fullscreen API; F11 also works). Arrow keys (`←` `→`) change slides. This is what the projector shows.
- **Presenter view** (`/d/<slug>/presenter`) — **next slide, speaker notes, and a timer**. This is your tab 2, on your laptop screen.

**Dual-screen workflow (the standard, zero-infrastructure case):** one laptop drives two displays. Drag the main view to the projector (extended display) and fullscreen it; keep the presenter view on your built-in screen. The two tabs sync via **BroadcastChannel** — same browser, no server — so clicking forward in either advances both.

> **Confirmed:** your laptop drives the projector as a second display, so the two views sync through the same browser **for free — no sync server needed.** (Only if you ever present from a room where a *separate* computer runs the projector would you need a small websocket sync server. Noted as a someday-edge-case, not in scope.)

**Students** open the public link, are prompted **once for a display name** (stored in their browser, sent with each AI request), then navigate the slides and use the sidebar.

---

## Identity, privacy & usage tracking

This is the part that turns the app from "basically static" into "static site + a tiny data store." Still small, but real.

- **Name on join.** A one-time prompt; the name is kept in the browser and attached to every AI request. It is *self-declared* — no login — so two students could share a name and you can't prove who's who. Fine for usage tracking; not fine for anything you'd want to secure.
- **Token tracking.** The serverless function reads the token usage OpenRouter returns on each call and increments that name's counter in a small key-value store (**Vercel KV / Upstash Redis** is the easy pick — free tier, one line to increment). You get a `name → tokens` leaderboard; OpenRouter's own dashboard gives you the total spend.
- **Prompts private to the user.** The function persists **only** `{ name, timestamp, token_count }` — never the prompt or the answer.

### The sharp edge on "private prompts"

"Private" needs a precise definition, because OpenRouter sits between you and the model:

1. Private **from you and other students** — yes, achievable: don't log prompt/response text anywhere (including error logs and the KV store).
2. Private **from third parties** — *not automatic*. The prompt still travels to OpenRouter and on to whichever model provider serves it, and some providers log or train on inputs unless you restrict them. So you must configure OpenRouter's data policy to no-logging / non-retaining providers, or the privacy promise is only half true.

There's also a **teaching tradeoff** baked into this choice: if you never store what students asked, you also can't audit what the AI *told* them. For a tool whose whole risk is "confidently teaching students wrong things," giving up that audit trail is a real cost. Worth deciding consciously — one middle path is to store anonymized/aggregated answers (not tied to a name) just so you can spot-check quality.

---

## Architecture (updated)

```
You (author)                                   Students (set a name on join)
   │                                               │
   ▼                                               ▼
Cursor / Claude ──prompt──▶ Custom slide app ──deploy──▶ Vercel
                                                    │
       ┌───────────────────────────┬───────────────┴──────────────┐
       ▼                           ▼                               ▼
  Main view  /              Presenter view  /presenter        AI sidebar
  (projector, fullscreen)   (next slide · notes · timer)      (Vue component)
       └──── nav syncs across tabs (same browser) ────┘             │ calls
                                                                    ▼
                                                     Vercel serverless function
                                                     ├─ calls OpenRouter (your model choice)
                                                     ├─ reads usage tokens from the response
                                                     ├─ increments {name → tokens} in KV
                                                     └─ returns answer only
                                                        (no prompt/response ever stored)
```

The serverless function holds the OpenRouter key — the browser never sees it. Use an OpenRouter key with a **hard spend cap** so a runaway loop or abuse can't drain the account.

---

## Build phases (importer still last)

**Phase 0 — Prove the pipeline + core slide behavior (½–1 day).** A one-slide custom deck with arrow-key navigation, URL-per-slide, and fullscreen working, deployed to Vercel. This is where you lock in the rules in `slide-system-rules.md`.

**Phase 1 — One real deck + build the presenter view (a weekend).** Author a deck for an actual class with speaker notes, and build the presenter view (next slide, notes, timer) + BroadcastChannel sync per the rules. **Test the dual-screen workflow on your real classroom hardware** — projector fullscreen + presenter view + timer — *before* you depend on it live. Add the **library home page** that lists your decks (one for now) so the multi-deck structure exists from day one. No sidebar yet.

**Phase 2 — Identity + AI sidebar, slides-only (the custom build).**
- Name-on-join prompt; store name in browser.
- Sidebar component → serverless function → OpenRouter, grounded with: *"Answer only from the provided slide content and notes; if it isn't there, say you don't know."*
- Wire token tracking into KV; enforce the "store counts, never text" rule.
- Configure OpenRouter data policy for privacy + a spend-capped key.
- Test against 10 real student-style questions.

**Phase 3 — RAG over course materials (only after Phase 2 earns it).** Embeddings → vector store → retrieval. Build only if students actually use the sidebar.

**Phase 4 — PPTX extractor script (optional, last).** `python-pptx` to pull content from old decks for the AI to rebuild.

---

## How you'll know it works (validation)

- **Phase 1:** You run a full class from it without breakage; projector + presenter view + timer behave on the real hardware; students navigate on their own devices.
- **Phase 2:** Of 10 real questions, how many does the AI answer correctly vs. invent? Any invention → tighten the prompt and force "I don't know." Confirm the KV store records tokens per name and that **no prompt text is written anywhere**.
- **Gate for Phase 3:** Do students actually open the sidebar? If not, skip RAG.

---

## Open questions to settle

*Resolved: (a) the projector runs off your laptop as a second display — presenter sync is free, no sync server. (b) The app is a **library of many decks** — a home page lists them, each deck has a permanent URL, decks are saved by deploying.*

1. **Public link = open wallet.** A spend-capped OpenRouter key + per-name tracking helps, but anyone with the URL can still use it. Add a gate before launch: a shared class password and/or per-name rate-limiting.
2. **OpenRouter data policy.** Confirm it's set so prompts aren't logged/trained on upstream, or "private prompts" only half holds.
3. **Audit vs. privacy tradeoff.** Accept zero visibility into AI answers, or store anonymized answers for quality spot-checks?
4. **RAG scope (Phase 3).** Which materials, how often updated.

---

## Risks to watch

- **"Private" leaking upstream.** Don't log prompt/response anywhere (KV, error logs, analytics), *and* restrict OpenRouter to non-retaining providers.
- **Losing your AI audit trail.** Privacy-by-not-logging means you can't catch the AI mis-teaching students. Mitigate with anonymized answer spot-checks if you want it.
- **Verify on real hardware.** Presenter sync is free on your same-laptop setup, but still do a Phase 1 dry run so projector fullscreen + timer behave in the actual room.
- **Scope creep back into "three products."** Viewer + presenter view + sidebar first; importer and in-app generation later or never.
- **The RAG temptation.** Slides-only until usage is proven.
- **Cost/abuse on a public endpoint.** Spend-capped key + a link gate.
- **Animation rabbit hole.** Timebox it per deck.

---

## Next concrete action

**Have your AI agent scaffold a one-slide custom deck — following `slide-system-rules.md` — and deploy it to Vercel today.** Confirm arrow-key navigation and `F` fullscreen work on the main view. That proves the hosting pipeline and the core slide behavior in one sitting; the presenter view follows in Phase 1.
