import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, getSession } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import { staticDecks } from "@/lib/decks/static";
import { deckSlugExists, insertUploadedDeck } from "@/lib/uploaded-decks";
import { validateDeckHtml } from "@/lib/deck-validator";
import { markdownToDeck, type DeckTheme } from "@/lib/markdown-deck";

// Markdown → deck import (#21). Widens authoring to non-coders: paste Markdown, get
// a themed, contract-valid VibeDeck deck with auto AI grounding. Server-side transform (one
// canonical renderer) → the SAME validate → insert → ground pipeline as upload, so
// containment (isolated origin + CSP + sandbox) and grounding come for free. The
// new deck is owned by the importer and lands unpublished.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 400_000; // Markdown source cap (before rendering)
const MAX_BODY = 500_000;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const VALID_THEMES: DeckTheme[] = ["light", "dark", "warm"];

async function currentSession() {
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  return getSession(token);
}

function collidesStatic(slug: string): boolean {
  return staticDecks.some((d) => d.slug === slug);
}
function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
async function firstFreeSlug(base: string): Promise<string> {
  for (let n = 1; n <= 1000; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!collidesStatic(candidate) && !(await deckSlugExists(candidate))) return candidate;
  }
  return `${base}-${Date.now()}`.slice(0, 64);
}

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

  let slug: string;
  try {
    let base = slugifyTitle(title) || "deck";
    if (!SLUG_RE.test(base)) base = "deck";
    slug = await firstFreeSlug(base);
  } catch {
    return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
  }

  // Attach branch directives before persistence: branches live in deck_slides,
  // not the generated HTML, and the whole bundle commits atomically below.
  const slides = validation.slides.map((s) =>
    rendered.branches[s.index] ? { ...s, branches: rendered.branches[s.index] } : s,
  );

  let result: "ok" | "conflict";
  try {
    result = await insertUploadedDeck({
      slug,
      title,
      date: todayIso(),
      description: null,
      html: rendered.html,
      ownerId: session.userId,
      slideCount: validation.slideCount,
      slides,
    });
  } catch {
    return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
  }
  if (result === "conflict") return NextResponse.json({ error: "slug_conflict" }, { status: 409 });

  return NextResponse.json(
    { slug, slideCount: validation.slideCount, warnings: validation.warnings },
    { status: 201 },
  );
}
