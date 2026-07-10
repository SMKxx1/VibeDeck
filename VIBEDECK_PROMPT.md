You are generating a **self-contained presentation deck** for VibeDeck. Produce **one HTML document** that follows these exact rules. When I tell you the topic, write the whole deck in a single reply as one HTML document and output nothing else.

## Structure

1. Output **one** HTML document — self-contained, no companion files.
2. It must contain **exactly one** `<deck-stage>` element, and every slide goes inside it. You may set the canvas size with `width` / `height` attributes, e.g. `<deck-stage width="1920" height="1080">` (a 16:9 default is used if you omit them). Do not use more than one `<deck-stage>`.
3. **Each slide is a direct `<section>` child of `<deck-stage>`.** A `<section>` nested inside any other element is NOT counted as a slide. Use between **1 and 300** slides.
4. Give every slide a `data-label="Short slide title"` attribute on its `<section>`. This is the slide's title in the presenter view and in navigation. A slide with no `data-label` still works, but shows no title.
5. Optional per-slide attributes, also on the `<section>`:
   - `data-speaker-notes="…"` — presenter-only notes (never shown to the audience).
   - `data-deck-skip` — skip this slide during normal navigation (e.g. an appendix slide).

## Styling and scripts (read carefully)

6. **All CSS and JavaScript must be inline** — inline `<style>` blocks and inline `<script>` blocks only. Inline interactivity is fully supported.
7. **Do NOT add any external `<script src="…">`, and do NOT include a slide/presentation framework or "deck runtime" of any kind** (reveal.js, impress.js, a custom engine, etc.). VibeDeck injects its own slide runtime automatically when the deck is displayed. A deck containing any `<script src>` is rejected on upload.
8. **No external network requests** — no CDN links, external stylesheets, web fonts, or remote images. The platform serves decks under a strict content-security policy that blocks them, so they silently fail. Embed images as `data:` URIs and use system fonts (e.g. `system-ui, sans-serif`).

## Optional AI grounding manifest

9. You MAY include a single grounding manifest so VibeDeck's built-in AI tutor can answer audience questions about the deck. It is exactly one script tag:

   ```html
   <script type="application/json" id="vibedeck-context">
   [
     {"index": 0, "label": "Title slide", "aiContext": "A short paragraph describing what this slide teaches, for the AI tutor to ground its answers on."},
     {"index": 1, "label": "Key idea", "aiContext": "…"}
   ]
   </script>
   ```

   - It is a JSON **array** with one entry per slide you want to describe. You can describe some or all slides. Omitting the manifest entirely is fine — the tutor then answers generically.
   - `index` is the **0-based** slide number (the first `<section>` is `0`). Every index must be in range and no index may repeat.
   - The array must not have more entries than there are slides.
   - `label` is a string of **≤ 200 characters**.
   - `aiContext` is a string of **≤ 8000 characters** — a plain-language summary of what the slide covers.
   - If the JSON is malformed or breaks any of these rules, the entire deck is rejected. Keep it strictly valid.

## Size

10. The finished HTML document must be **≤ 2 MB** in total, including any inline images.

## Example — a minimal conforming 2-slide deck

```html
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Tides, explained</title></head>
<body>
  <deck-stage width="1920" height="1080">
    <section data-label="Title" data-speaker-notes="Welcome the room; ask who has read a tide chart.">
      <style>
        .title-slide { display:flex; flex-direction:column; justify-content:center; height:100%; padding:8%; font-family: system-ui, sans-serif; background:#0b1020; color:#f2f6fc; }
        .title-slide h1 { font-size:5rem; margin:0; letter-spacing:-0.02em; }
        .title-slide p { font-size:1.6rem; color:#9fb0cc; }
      </style>
      <div class="title-slide">
        <h1>Tides, explained</h1>
        <p>Why the sea breathes twice a day</p>
      </div>
    </section>

    <section data-label="The Moon's pull">
      <style>
        .pull { display:flex; flex-direction:column; justify-content:center; height:100%; padding:8%; font-family: system-ui, sans-serif; background:#0e1426; color:#f2f6fc; }
        .pull h2 { font-size:3.2rem; margin:0 0 1rem; cursor:pointer; }
        .pull h2.lit { color:#f5a623; }
        .pull li { font-size:1.8rem; line-height:1.5; }
      </style>
      <div class="pull">
        <h2>The Moon's pull</h2>
        <ul>
          <li>Gravity tugs the ocean toward the Moon.</li>
          <li>A matching bulge forms on the far side of Earth.</li>
          <li>Earth spins through both bulges — two highs a day.</li>
        </ul>
      </div>
      <script>
        // Inline JS is allowed and runs inside the slide. External <script src> is not.
        const heading = document.currentScript.closest("section").querySelector("h2");
        heading.addEventListener("click", () => heading.classList.toggle("lit"));
      </script>
    </section>
  </deck-stage>

  <script type="application/json" id="vibedeck-context">
  [
    {"index": 0, "label": "Title", "aiContext": "Opening slide for a short talk on ocean tides, for a general audience."},
    {"index": 1, "label": "The Moon's pull", "aiContext": "Explains that the Moon's gravity raises an ocean bulge, with a matching bulge on the opposite side of Earth, so most coasts see two high tides each day."}
  ]
  </script>
</body>
</html>
```

Now write a deck about the topic I give you, following every rule above. Output only the HTML document.
