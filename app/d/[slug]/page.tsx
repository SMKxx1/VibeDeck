import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import type { Metadata } from "next";
import { getDeck } from "@/lib/decks";
import { DeckViewer } from "@/components/DeckViewer";
import { LiveDeck } from "@/components/LiveDeck";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";

// Rendered on-demand (never statically baked): the live (embed) deck reads the
// presenter session cookie to pick presenter-vs-viewer, a per-request dynamic
// API. Since this route is shared with the hand-authored decks, the whole route
// must be dynamic — otherwise Next statically optimizes it and the embed deck's
// cookie read throws DYNAMIC_SERVER_USAGE (a 500) in production.
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const deck = getDeck(slug);
  return { title: deck ? deck.title : "Deck not found" };
}

export default async function DeckPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const deck = getDeck(slug);
  if (!deck) notFound();

  // Self-contained live decks: the presenter (valid session cookie) drives;
  // everyone else is a viewer. Reading the cookie renders this path dynamically.
  if (deck.embedUrl) {
    const token = (await cookies()).get(AUTH_COOKIE)?.value;
    const role = verifySessionToken(token) ? "presenter" : "viewer";
    return <LiveDeck slug={deck.slug} embedUrl={deck.embedUrl} role={role} title={deck.title} />;
  }

  return <DeckViewer deck={deck} />;
}
