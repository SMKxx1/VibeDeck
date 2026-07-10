// Server-side conformance validator for UPLOADED deck HTML (Phase 2). Server-only.
//
// This is the structural GATE on untrusted, user-supplied HTML: it runs at
// upload/replace time and REJECTS non-conforming decks before they are ever
// stored, so every stored uploaded deck is guaranteed to be a well-formed
// VibeDeck bundle. It is NOT a security control — the security boundary is the
// separate DECK_ORIGIN + strict CSP + sandboxed frame (Phase 0.5/1). This layer
// is conformance: "will the shared runtime actually render this, and can we
// safely derive the deck's slide list + AI grounding from it."
//
// The other half of validation — "does it actually boot in a real browser" — is
// a client-side hidden-iframe handshake check the dashboard runs after upload;
// that needs a real browser and can't be done here. This module owns everything
// that can be decided from the bytes alone.
//
// A conforming bundle (the contract authors / the /build prompt target):
//   • exactly one <deck-stage> element
//   • its direct <section> children are the slides (>=1, <=MAX_SLIDES)
//   • each slide MAY carry data-label (title), data-speaker-notes, data-deck-skip
//   • inline <script>/<style> only — NO <script src> (the platform injects the
//     runtime at serve time; external scripts can't load under the deck CSP anyway)
//   • an OPTIONAL AI manifest:
//       <script type="application/json" id="vibedeck-context">
//         [{ "index": 0, "label": "…", "aiContext": "paragraph the tutor grounds on" }, …]
//       </script>
//     absent/empty → the deck simply has no authored AI grounding (generic answers).

import { parse, type HTMLElement } from "node-html-parser";

// Bounds. MAX_SLIDES caps both the parse work and the number of deck_slides
// upserts a single upload can trigger (a 2MB body of empty <section>s would
// otherwise be a cheap self-DoS even though the route is presenter-gated).
// MAX_AI_CONTEXT mirrors the 8000-char per-field limit the manual notes editor
// enforces (app/api/admin/slides/route.ts) — but note that limit is NOT shared
// code; the manifest path has no other length gate, so this IS the only bound on
// what the manifest can write into deck_slides.ai_context.
export const MAX_SLIDES = 300;
const MAX_LABEL = 200;
const MAX_AI_CONTEXT = 8000;
const MAX_SPEAKER_NOTES = 8000;

// One slide's derived metadata, ready to upsert into deck_slides. label/aiContext
// prefer the manifest entry (the author's explicit AI declaration) and fall back
// to the section's own data-* attributes; speakerNotes come only from the section.
export interface DeckSlideMeta {
  index: number;
  label: string;
  aiContext: string;
  speakerNotes: string;
}

export interface DeckValidationResult {
  ok: boolean;
  issues: string[]; // fatal — a non-empty list means reject the upload
  warnings: string[]; // non-fatal — surfaced to the presenter, deck still accepted
  slideCount: number;
  // Present only when ok: the per-slide metadata to write into deck_slides.
  slides: DeckSlideMeta[];
}

interface ManifestEntry {
  index: number;
  label?: string;
  aiContext?: string;
}

// Direct <section> element children of a node (not descendants — a slide is a
// DIRECT child of <deck-stage>, matching deck-stage.js's own slide discovery).
function directSections(el: HTMLElement): HTMLElement[] {
  return el.childNodes.filter(
    (n): n is HTMLElement =>
      // node-html-parser element nodes expose an uppercase tagName; text/comment
      // nodes have tagName null.
      (n as HTMLElement).tagName === "SECTION",
  ) as HTMLElement[];
}

// Parse + validate the manifest <script>, if present. Returns {entries} on success
// (entries may be []), or pushes fatal issues and returns null. Kept strict: a
// malformed manifest is a hard reject, not a silent skip, so an author never
// ships a deck they THINK has AI grounding but doesn't.
function parseManifest(
  root: HTMLElement,
  slideCount: number,
  issues: string[],
): ManifestEntry[] | null {
  const scripts = root.querySelectorAll("script");
  const manifestEl = scripts.find(
    (s) =>
      (s.getAttribute("type") || "").toLowerCase() === "application/json" &&
      s.getAttribute("id") === "vibedeck-context",
  );
  if (!manifestEl) return []; // no manifest is legal — deck just has no AI grounding

  // node-html-parser keeps a <script>'s body as raw text; .text is its textContent.
  const raw = manifestEl.text.trim();
  if (!raw) return []; // empty manifest tag — treat as "none", not an error

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    issues.push("The vibedeck-context manifest is not valid JSON.");
    return null;
  }
  if (!Array.isArray(data)) {
    issues.push("The vibedeck-context manifest must be a JSON array.");
    return null;
  }
  if (data.length > slideCount) {
    issues.push(
      `The manifest has ${data.length} entries but the deck has only ${slideCount} slides.`,
    );
    return null;
  }

  const seen = new Set<number>();
  const entries: ManifestEntry[] = [];
  for (let i = 0; i < data.length; i++) {
    const e = data[i] as Record<string, unknown>;
    if (typeof e !== "object" || e === null) {
      issues.push(`Manifest entry ${i} is not an object.`);
      continue;
    }
    const index = e.index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= slideCount) {
      issues.push(
        `Manifest entry ${i} has an out-of-range or non-integer "index" (must be 0..${slideCount - 1}).`,
      );
      continue;
    }
    if (seen.has(index)) {
      issues.push(`Manifest has a duplicate entry for slide index ${index}.`);
      continue;
    }
    seen.add(index);
    const entry: ManifestEntry = { index };
    if (e.label !== undefined) {
      if (typeof e.label !== "string" || e.label.length > MAX_LABEL) {
        issues.push(`Manifest entry for slide ${index}: "label" must be a string <= ${MAX_LABEL} chars.`);
        continue;
      }
      entry.label = e.label;
    }
    if (e.aiContext !== undefined) {
      if (typeof e.aiContext !== "string" || e.aiContext.length > MAX_AI_CONTEXT) {
        issues.push(
          `Manifest entry for slide ${index}: "aiContext" must be a string <= ${MAX_AI_CONTEXT} chars.`,
        );
        continue;
      }
      entry.aiContext = e.aiContext;
    }
    entries.push(entry);
  }
  return issues.length ? null : entries;
}

/**
 * Validate an uploaded deck's raw stored HTML against the VibeDeck bundle
 * contract. Never throws — a parse failure is reported as an issue, not an
 * exception, so the upload route can always return a clean 422. When `ok`, the
 * returned `slides` are ready to batch-upsert into deck_slides.
 */
export function validateDeckHtml(html: string): DeckValidationResult {
  const issues: string[] = [];
  const warnings: string[] = [];

  let root: HTMLElement;
  try {
    root = parse(html, {
      // Keep the manifest <script>'s JSON body intact and parse block/inline
      // structure; comments are irrelevant to the contract.
      comment: false,
    });
  } catch {
    return { ok: false, issues: ["The deck HTML could not be parsed."], warnings, slideCount: 0, slides: [] };
  }

  // Exactly one <deck-stage>.
  const stages = root.querySelectorAll("deck-stage");
  if (stages.length === 0) {
    issues.push("No <deck-stage> element found. A VibeDeck deck must wrap its slides in a single <deck-stage>.");
    return { ok: false, issues, warnings, slideCount: 0, slides: [] };
  }
  if (stages.length > 1) {
    issues.push(`Found ${stages.length} <deck-stage> elements; a deck must have exactly one.`);
    return { ok: false, issues, warnings, slideCount: 0, slides: [] };
  }
  const stage = stages[0];

  // Direct <section> children are the slides.
  const sections = directSections(stage);
  if (sections.length === 0) {
    issues.push("The <deck-stage> has no <section> slides. Each slide is a direct <section> child of <deck-stage>.");
    return { ok: false, issues, warnings, slideCount: 0, slides: [] };
  }
  if (sections.length > MAX_SLIDES) {
    issues.push(`The deck has ${sections.length} slides; the maximum is ${MAX_SLIDES}.`);
    return { ok: false, issues, warnings, slideCount: sections.length, slides: [] };
  }
  const slideCount = sections.length;

  // No external <script src> anywhere — authors use inline scripts only; the
  // platform injects the runtime at serve time, and external scripts can't load
  // under the deck CSP regardless. Reject rather than silently letting a dead
  // <script src> ship (it signals the author misunderstood the contract).
  const scriptsWithSrc = root.querySelectorAll("script").filter((s) => {
    const src = s.getAttribute("src");
    return typeof src === "string" && src.trim().length > 0;
  });
  if (scriptsWithSrc.length > 0) {
    issues.push(
      "External <script src> is not allowed. Put all deck logic in inline <script> tags; the platform provides the slide runtime automatically.",
    );
  }

  // Manifest (optional). Parsed against slideCount so indices can be range-checked.
  const manifest = parseManifest(root, slideCount, issues);

  if (issues.length > 0) {
    return { ok: false, issues, warnings, slideCount, slides: [] };
  }

  // Build the per-slide metadata. label/aiContext prefer the manifest; label
  // falls back to the section's data-label; speaker notes come from the section.
  const byIndex = new Map<number, ManifestEntry>();
  for (const e of manifest ?? []) byIndex.set(e.index, e);

  const slides: DeckSlideMeta[] = sections.map((sec, i) => {
    const m = byIndex.get(i);
    const sectionLabel = (sec.getAttribute("data-label") || "").slice(0, MAX_LABEL);
    const sectionNotes = (sec.getAttribute("data-speaker-notes") || "").slice(0, MAX_SPEAKER_NOTES);
    if (!sectionLabel && !m?.label) {
      warnings.push(`Slide ${i + 1} has no data-label — it won't show a title in the presenter view or navigation.`);
    }
    return {
      index: i,
      label: m?.label ?? sectionLabel,
      aiContext: (m?.aiContext ?? "").slice(0, MAX_AI_CONTEXT),
      speakerNotes: sectionNotes,
    };
  });

  return { ok: true, issues, warnings, slideCount, slides };
}
