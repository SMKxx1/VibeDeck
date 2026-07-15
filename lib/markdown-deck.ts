// Markdown → VibeDeck bundle (#21). A zero-dependency renderer that turns a
// Markdown document (slides separated by a `---` line) into a contract-valid
// VibeDeck deck: <deck-stage> + one <section> per slide, themed, self-contained.
// The output goes through validateDeckHtml + the normal upload path, and is served
// only on the isolated DECK_ORIGIN under the strict CSP + sandbox — so this is a
// CONVENIENCE/authoring transform, not a security boundary. We still HTML-escape
// all text so Markdown content renders as text, not markup.
//
// Deliberately a SUBSET of Markdown (the part that makes sense on a slide):
// headings, paragraphs, unordered/ordered lists, bold/italic/inline-code, fenced
// code blocks, blockquotes, links, and images. No tables — that's the documented
// fidelity boundary.
//
// IMAGES: `![alt](url)` emits a plain <img> with the src/alt escaped. NOTE that
// under the deck CSP ("img-src 'self' data:") only SAME-ORIGIN URLs — i.e. the
// Deck Asset Vault's /d-assets/<slug>/<hash> paths (or anything else on the deck
// origin) — and data: URIs will actually render; a remote http(s) image is
// CSP-blocked BY DESIGN (the sandboxed deck must not phone home). We emit the
// tag regardless and let the CSP enforce that; we deliberately do NOT fetch or
// inline remote images at import time.

import { sanitizeBranches, type SlideBranch } from "./types";

export type DeckTheme = "light" | "dark" | "warm";

const THEMES: Record<DeckTheme, string> = {
  light:
    "background:#ffffff;color:#1a1a1a;" +
    "--accent:#2563eb;--muted:#5b6472;--surface:#f4f6fa;",
  dark:
    "background:#0f1117;color:#e8eaf0;" +
    "--accent:#7dd3fc;--muted:#9aa3b2;--surface:#1a1d27;",
  warm:
    "background:#ECEAE3;color:#2C2A31;" +
    "--accent:#7BA80C;--muted:#6E6A62;--surface:#f6f4ee;",
};

function themeCss(theme: DeckTheme): string {
  const base = THEMES[theme] ?? THEMES.light;
  // The runtime (deck-stage) scales the 1280x720 stage; sections just fill it.
  return `
    deck-stage { display:block; }
    section {
      box-sizing:border-box; width:100%; height:100%;
      display:flex; flex-direction:column; justify-content:center;
      padding:70px 96px; ${base}
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      line-height:1.5; overflow:hidden;
    }
    section > :first-child { margin-top:0; }
    section > :last-child { margin-bottom:0; }
    h1 { font-size:clamp(34px,5vw,60px); line-height:1.08; letter-spacing:-.02em; margin:0 0 .35em; font-weight:700; }
    h2 { font-size:clamp(26px,3.4vw,40px); line-height:1.15; margin:0 0 .4em; font-weight:650; }
    h3 { font-size:clamp(20px,2.4vw,28px); margin:0 0 .4em; font-weight:600; color:var(--accent); }
    p { font-size:clamp(17px,1.7vw,24px); margin:0 0 .7em; }
    ul, ol { font-size:clamp(17px,1.7vw,24px); margin:.2em 0 .7em; padding-left:1.3em; }
    li { margin:.28em 0; }
    strong { font-weight:700; }
    em { font-style:italic; }
    a { color:var(--accent); text-decoration:underline; }
    code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size:.9em;
           background:var(--surface); padding:.1em .35em; border-radius:5px; }
    pre { background:var(--surface); border-radius:10px; padding:18px 22px; overflow:auto;
          font-size:clamp(14px,1.3vw,18px); margin:.4em 0 .7em; }
    pre code { background:none; padding:0; }
    blockquote { margin:.4em 0 .7em; padding-left:18px; border-left:4px solid var(--accent);
                 color:var(--muted); font-style:italic; }
    img { max-width:100%; max-height:420px; object-fit:contain; border-radius:10px;
          display:block; margin:.3em 0 .7em; }
  `.trim();
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escAttr(s: string): string {
  return esc(s).replace(/"/g, "&quot;");
}

// Inline formatting on ALREADY-ESCAPED text: code spans first (so their contents
// aren't re-formatted), then images (before links — `![x](y)` must not be eaten
// by the link rule), links, bold, italic. Only http(s) links are emitted; image
// srcs may also be relative (/d-assets/…) or data: — see the file header for
// which of those the deck CSP will actually render.
function inline(escaped: string): string {
  let t = escaped;
  const codes: string[] = [];
  t = t.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(`<code>${c}</code>`);
    return `\u0000${codes.length - 1}\u0000`; // placeholder so bold/italic skip code
  });
  t = t.replace(/!\[([^\]]*)\]\(([^\s)]+)\)/g, (_m, alt: string, url: string) => {
    // Text is already HTML-escaped; only quotes still need escaping inside the
    // attribute values (escAttr on `url` would double-escape its `&`s).
    return `<img src="${url.replace(/"/g, "&quot;")}" alt="${alt.replace(/"/g, "&quot;")}">`;
  });
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, txt: string, url: string) => {
    return `<a href="${escAttr(url)}" target="_blank" rel="noopener noreferrer">${txt}</a>`;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  t = t.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
  t = t.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)] ?? "");
  return t;
}

// Render ONE slide's Markdown body to HTML (block-level line parser).
function renderBody(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(esc(para.join(" ")))}</p>`);
      para = [];
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^```/.test(trimmed)) {
      flushPara();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        code.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
      continue;
    }

    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      const level = Math.min(6, h[1].length);
      out.push(`<h${level}>${inline(esc(h[2].trim()))}</h${level}>`);
      i++;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      flushPara();
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        quote.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${inline(esc(quote.join(" ")))}</blockquote>`);
      continue;
    }

    if (/^[-*+]\s+/.test(trimmed)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        items.push(`<li>${inline(esc(lines[i].trim().replace(/^[-*+]\s+/, "")))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(`<li>${inline(esc(lines[i].trim().replace(/^\d+\.\s+/, "")))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    if (trimmed === "") {
      flushPara();
      i++;
      continue;
    }

    para.push(trimmed);
    i++;
  }
  flushPara();
  return out.join("\n");
}

/**
 * Render a Markdown FRAGMENT (no slide splitting, no <deck-stage> wrapper) to
 * HTML-escaped markup — the SAME zero-dependency block renderer the deck
 * importer uses, exported so other markdown surfaces (the study-guide handout
 * page + its offline download) reuse this one escaping renderer instead of
 * growing a second one. Same fidelity boundary as the deck subset: headings,
 * paragraphs, lists, bold/italic/inline-code, fenced code, blockquotes, and
 * http(s) links — all text HTML-escaped; no tables/images/raw HTML.
 */
export function renderMarkdownFragment(markdown: string): string {
  return renderBody(markdown ?? "");
}

// ── Branch directive (branch points) ────────────────────────────────────────
// A slide may declare an audience-voted branch point with a fenced `branch`
// block — part of the documented Markdown subset, removed from the rendered
// slide:
//
//   ```branch
//   Deep-dive the API -> 5-8
//   Show the demo -> 9
//   ```
//
// One path per line: `Label -> from-to` (or a single slide number), using
// 1-BASED slide numbers as an author counts them. Lines that don't parse are
// ignored; a block that doesn't yield 2–4 valid in-range paths yields no branch
// point (lenient — an import never fails on a directive typo). Converted to the
// canonical 0-based SlideBranch shape via the shared sanitizeBranches rule.
const BRANCH_FENCE_RE = /^```branch[ \t]*\n([\s\S]*?)^```[ \t]*$/gm;
const BRANCH_LINE_RE = /^(.+?)->\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*$/;

function parseBranchLines(block: string): { label: string; from: number; to: number }[] {
  const out: { label: string; from: number; to: number }[] = [];
  for (const line of block.split("\n")) {
    const m = line.trim().match(BRANCH_LINE_RE);
    if (!m) continue;
    const from = Number(m[2]) - 1; // 1-based author numbering → 0-based
    const to = (m[3] !== undefined ? Number(m[3]) : Number(m[2])) - 1;
    out.push({ label: m[1].trim(), from, to });
  }
  return out;
}

// Strip every branch fence from one slide's Markdown, collecting its path lines.
function extractBranchDirective(md: string): { md: string; entries: { label: string; from: number; to: number }[] } {
  const entries: { label: string; from: number; to: number }[] = [];
  const stripped = md.replace(BRANCH_FENCE_RE, (_m, block: string) => {
    entries.push(...parseBranchLines(block));
    return "";
  });
  return { md: stripped, entries };
}

// The label for a slide = its first heading text, else "Slide N".
function slideLabel(md: string, n: number): string {
  const m = md.match(/^\s*#{1,6}\s+(.*)$/m);
  const label = m ? m[1].trim().replace(/[*_`]/g, "") : "";
  return (label || `Slide ${n}`).slice(0, 120);
}

export interface MarkdownDeckResult {
  html: string;
  slideCount: number;
  title: string;
  /**
   * Per-slide branch points from `branch` directives (0-based slide index →
   * paths), or null for non-branch slides. Parallel to the rendered sections.
   * The import route merges these into the deck_slides metadata — they are NOT
   * part of the HTML.
   */
  branches: (SlideBranch[] | null)[];
}

/**
 * Convert a Markdown document into a VibeDeck bundle. Slides are separated by a
 * line containing only `---`. Returns the full self-contained HTML plus a derived
 * title (the first slide's heading). Always produces >=1 <section>.
 */
export function markdownToDeck(markdown: string, theme: DeckTheme = "light"): MarkdownDeckResult {
  const normalized = (markdown ?? "").replace(/\r\n?/g, "\n");
  // Split on a line that is exactly `---` (optionally surrounded by whitespace).
  const parts = normalized
    .split(/\n[ \t]*---[ \t]*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const rawSlides = parts.length > 0 ? parts : [normalized.trim() || "# Untitled"];

  // Pull each slide's branch directive out BEFORE rendering, so the fence never
  // reaches the generic code-block renderer. Range-check against the final slide
  // count (targets must point inside this deck).
  const extracted = rawSlides.map((md) => extractBranchDirective(md));
  const slidesMd = extracted.map((e) => e.md.trim() || "# Untitled");
  const branches = extracted.map((e) => sanitizeBranches(e.entries, rawSlides.length));

  const sections = slidesMd
    .map((md, idx) => {
      const label = slideLabel(md, idx + 1);
      const body = renderBody(md) || `<h1>${esc(label)}</h1>`;
      return `<section data-label="${escAttr(label)}">\n${body}\n</section>`;
    })
    .join("\n");

  const title = slideLabel(slidesMd[0], 1);
  const html =
    `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>${escAttr(title)}</title>\n<style>\n${themeCss(theme)}\n</style>\n</head>\n` +
    `<body>\n<deck-stage width="1280" height="720">\n${sections}\n</deck-stage>\n</body>\n</html>\n`;

  return { html, slideCount: slidesMd.length, title, branches };
}
