import { NextResponse } from "next/server";
import { currentSession } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import { validateDeckHtml } from "@/lib/deck-validator";
import { markdownToDeck, type DeckTheme } from "@/lib/markdown-deck";
import {
  SLUG_RE,
  allocateSlug,
  slugifyTitle,
  storeUploadedDeck,
  todayIso,
} from "@/lib/deck-create";

// Markdown → deck import (#21). Widens authoring to non-coders: paste Markdown, get
// a themed, contract-valid VibeDeck deck with auto AI grounding. Server-side transform (one
// canonical renderer) → the SAME validate → insert → ground pipeline as upload, so
// containment (isolated origin + CSP + sandbox) and grounding come for free. The
// new deck is owned by the importer and lands unpublished.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 400_000; // Markdown source cap (before rendering)
const MAX_BODY = 500_000;
const VALID_THEMES: DeckTheme[] = ["light", "dark", "warm"];

interface Body {
  markdown?: unknown;
  title?: unknown;
  theme?: unknown;
}

export async function POST(req: Request) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const lenHeader = req.headers.get("content-length");
  const len = lenHeader === null ? NaN : Number(lenHeader);
  if (!Number.isFinite(len) || len <= 0 || len > MAX_BODY) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const markdown = typeof body.markdown === "string" ? body.markdown : "";
  if (!markdown.trim()) return NextResponse.json({ error: "empty_markdown" }, { status: 400 });
  if (Buffer.byteLength(markdown, "utf8") > MAX_BYTES) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }
  const theme: DeckTheme =
    typeof body.theme === "string" && (VALID_THEMES as string[]).includes(body.theme)
      ? (body.theme as DeckTheme)
      : "light";

  const rendered = markdownToDeck(markdown, theme);
  const title =
    typeof body.title === "string" && body.title.trim()
      ? body.title.trim().slice(0, 200)
      : rendered.title;

  // Defensive: the renderer targets the contract, but validate anyway (never store
  // a non-conforming bundle) — a validator change or a pathological input is caught.
  const validation = validateDeckHtml(rendered.html);
  if (!validation.ok) {
    return NextResponse.json(
      { error: "invalid_deck", issues: validation.issues },
      { status: 422 },
    );
  }

  let base = slugifyTitle(title) || "deck";
  if (!SLUG_RE.test(base)) base = "deck";
  const allocated = await allocateSlug(base);
  if (!allocated.ok) {
    return NextResponse.json({ error: allocated.error }, { status: allocated.status });
  }
  const slug = allocated.slug;

  // Attach branch directives before persistence: branches live in deck_slides,
  // not the generated HTML, and the whole bundle commits atomically below.
  const slides = validation.slides.map((s) =>
    rendered.branches[s.index] ? { ...s, branches: rendered.branches[s.index] } : s,
  );

  const stored = await storeUploadedDeck({
    slug,
    title,
    date: todayIso(),
    description: null,
    html: rendered.html,
    ownerId: session.userId,
    slideCount: validation.slideCount,
    slides,
  });
  if (!stored.ok) return NextResponse.json({ error: stored.error }, { status: stored.status });

  return NextResponse.json(
    { slug, slideCount: validation.slideCount, warnings: validation.warnings },
    { status: 201 },
  );
}
