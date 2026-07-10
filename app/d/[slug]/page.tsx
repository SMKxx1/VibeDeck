import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import type { Metadata } from "next";
import { getDeck } from "@/lib/decks";
import { DeckViewer } from "@/components/DeckViewer";
import { LiveDeck } from "@/components/LiveDeck";
import { UploadedDeckFrame } from "@/components/UploadedDeckFrame";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { isDeckViewable, getPublishStatusMap } from "@/lib/publish-store";

// Rendered on-demand (never statically baked): the live (embed) deck reads the
// presenter session cookie to pick presenter-vs-viewer, a per-request dynamic
// API. Since this route is shared with the hand-authored decks, the whole route
// must be dynamic — otherwise Next statically optimizes it and the embed deck's
// cookie read throws DYNAMIC_SERVER_USAGE (a 500) in production.
export const dynamic = "force-dynamic";

async function isPresenter(): Promise<boolean> {
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  return verifySessionToken(token);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const deck = await getDeck(slug);
  const presenter = await isPresenter();

  // Do NOT leak the real title for a deck this caller can't view: an unpublished
  // deck's page 404s, and its <title> must read the same "Deck not found" as a
  // genuinely-missing deck (avoids confirming the slug exists) plus a noindex so
  // it never lands in a search index if a stray link is followed.
  if (!deck || !(await isDeckViewable(slug, presenter))) {
    return { title: "Deck not found", robots: { index: false, follow: false } };
  }

  // For a viewable-but-unpublished deck (only presenters reach here), keep it out
  // of search indexes too — it's presenter-only content. Normal/main decks omit
  // the robots field entirely and stay indexable by default.
  const statusMap = await getPublishStatusMap();
  if (statusMap[slug] === "unpublished") {
    return { title: deck.title, robots: { index: false, follow: false } };
  }
  return { title: deck.title };
}

export default async function DeckPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const deck = await getDeck(slug);
  if (!deck) notFound();

  // Publish gate: an unpublished deck 404s for non-presenters (a hard 404, not a
  // login redirect — a non-presenter must not be able to tell "doesn't exist"
  // from "exists but hidden", which would let them enumerate slugs). Presenters
  // always pass (isDeckViewable short-circuits on the presenter flag).
  const presenter = await isPresenter();
  if (!(await isDeckViewable(slug, presenter))) notFound();

  // Uploaded decks render as an isolated, bridge-less sandboxed artifact — check
  // this BEFORE the embedUrl branch (an uploaded deck has no embedUrl and must
  // never be routed through the trusted-first-party LiveDeck path).
  if (deck.kind === "uploaded") return <UploadedDeckFrame deck={deck} role={presenter ? "presenter" : "viewer"} />;

  // Self-contained live decks: the presenter (valid session cookie) drives;
  // everyone else is a viewer. Reading the cookie renders this path dynamically.
  if (deck.embedUrl) {
    const role = presenter ? "presenter" : "viewer";
    return <LiveDeck slug={deck.slug} embedUrl={deck.embedUrl} role={role} title={deck.title} />;
  }

  return <DeckViewer deck={deck} />;
}
