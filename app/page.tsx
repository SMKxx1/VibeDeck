import { notFound } from "next/navigation";
import { getDeck } from "@/lib/decks";
import { LiveDeck } from "@/components/LiveDeck";

// The main page IS the live workshop deck, entered as a viewer (name gate first).
// Presenters sign in at /login → /dashboard and present from there.
const LIVE_SLUG = process.env.NEXT_PUBLIC_LIVE_DECK_SLUG || "build-host-website";

export default function HomePage() {
  const deck = getDeck(LIVE_SLUG);
  if (!deck || !deck.embedUrl) notFound();
  return <LiveDeck slug={deck.slug} embedUrl={deck.embedUrl} role="viewer" title={deck.title} />;
}
